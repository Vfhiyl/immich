import { X509Certificate, createHash, createPrivateKey, createPublicKey, randomBytes, webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// before @peculiar/x509, which needs the metadata of decorators (Nest loads it too, but not every user of this file)
import 'reflect-metadata';

/** @peculiar/x509, loaded when a certificate is made (after reflect-metadata, which imports cannot order) */
const loadX509 = async () => {
  const x509 = await import('@peculiar/x509');
  x509.cryptoProvider.set(webcrypto as unknown as Crypto);
  return x509;
};

/**
How long a certificate is valid: at most 825 days, as Apple requires of every TLS server certificate issued after July
2019 (https://support.apple.com/en-us/103769). The app trusts the public key, not the certificate, so a new certificate
for the same key changes nothing for it.
*/
export const CERTIFICATE_LIFETIME_DAYS = 825;
/** A certificate is made again with the same key when it has less than this left */
export const CERTIFICATE_RENEW_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_FILE = 'key.pem';
const CERTIFICATE_FILE = 'certificate.pem';
const ALGORITHM: EcKeyImportParams & EcdsaParams = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };

export type SelfSignedCertificate = {
  /** PEM of the private key (PKCS #8) */
  key: string;
  /** PEM of the certificate */
  certificate: string;
  /** When the certificate ends */
  notAfter: Date;
  /** SHA-256 of the public key (SubjectPublicKeyInfo), base64: what the app pins */
  pin: string;
};

/** SHA-256 of the SubjectPublicKeyInfo of a key or certificate, base64 (the pins of Android, Cronet and HPKP) */
export const getPin = (keyOrCertificate: string): string => {
  const publicKey = createPublicKey(keyOrCertificate);
  return createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
};

/** The pin as people compare it: 64 hexadecimal digits in 16 groups of 4 */
export const formatPin = (pin: string): string =>
  Buffer.from(pin, 'base64').toString('hex').toUpperCase().match(/.{4}/g)!.join(' ');

const writePrivate = (path: string, content: string) => {
  // written whole, then renamed, so that a crash never leaves half a key
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
};

const createCertificate = async (keyPem: string, now: Date): Promise<string> => {
  const x509 = await loadX509();
  const privateKey = createPrivateKey(keyPem);
  const keys: CryptoKeyPair = {
    privateKey: await webcrypto.subtle.importKey(
      'pkcs8',
      privateKey.export({ type: 'pkcs8', format: 'der' }),
      ALGORITHM,
      true,
      ['sign'],
    ),
    publicKey: await webcrypto.subtle.importKey(
      'spki',
      createPublicKey(privateKey).export({ type: 'spki', format: 'der' }),
      ALGORITHM,
      true,
      ['verify'],
    ),
  } as CryptoKeyPair;

  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16)
      .toString('hex')
      .replace(/^[89a-f]/, '1'),
    name: 'CN=Immich',
    notBefore: new Date(now.getTime() - DAY_MS),
    notAfter: new Date(now.getTime() + CERTIFICATE_LIFETIME_DAYS * DAY_MS - DAY_MS),
    keys,
    signingAlgorithm: ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'immich' }]),
    ],
  });
  return certificate.toString('pem');
};

const readCertificate = (folder: string): SelfSignedCertificate | undefined => {
  const keyPath = join(folder, KEY_FILE);
  const certificatePath = join(folder, CERTIFICATE_FILE);
  if (!existsSync(keyPath) || !existsSync(certificatePath)) {
    return;
  }
  const key = readFileSync(keyPath, 'utf8');
  const certificate = readFileSync(certificatePath, 'utf8');
  const pin = getPin(key);
  if (getPin(certificate) !== pin) {
    return;
  }
  return { key, certificate, notAfter: new X509Certificate(certificate).validToDate, pin };
};

/**
The key and certificate of the server's HTTPS port in self-signed mode, from `folder`. The key is made once and kept:
the app pins it, so a new key means signing in every phone again. The certificate is made again for the same key when
it is missing, is not of the key, or ends within `CERTIFICATE_RENEW_DAYS`.
*/
export const loadSelfSignedCertificate = async (
  folder: string,
  now = new Date(),
): Promise<{ certificate: SelfSignedCertificate; created: 'key' | 'certificate' | false }> => {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const keyPath = join(folder, KEY_FILE);

  let created: 'key' | 'certificate' | false = false;
  if (!existsSync(keyPath)) {
    const { privateKey } = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
    const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', privateKey));
    writePrivate(
      keyPath,
      createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' }) as string,
    );
    created = 'key';
  }

  const existing = readCertificate(folder);
  if (existing && existing.notAfter.getTime() - now.getTime() > CERTIFICATE_RENEW_DAYS * DAY_MS) {
    return { certificate: existing, created };
  }

  const key = readFileSync(keyPath, 'utf8');
  writePrivate(join(folder, CERTIFICATE_FILE), await createCertificate(key, now));
  return { certificate: readCertificate(folder)!, created: created || 'certificate' };
};

/** The pin of the key in `folder`, or undefined when there is none yet (for the command line) */
export const readPin = (folder: string): string | undefined => {
  const keyPath = join(folder, KEY_FILE);
  return existsSync(keyPath) ? getPin(readFileSync(keyPath, 'utf8')) : undefined;
};

/** The folder of the key and certificate in self-signed mode: as configured, or `tls` in the media location */
export const getTlsLocation = (selfSignedTls: { location?: string }, mediaLocation: string) =>
  selfSignedTls.location ?? join(mediaLocation, 'tls');
