import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CERTIFICATE_LIFETIME_DAYS,
  CERTIFICATE_RENEW_DAYS,
  formatPin,
  getPin,
  getTlsLocation,
  loadSelfSignedCertificate,
  readPin,
} from 'src/utils/tls.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('self-signed TLS', () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'immich-tls-'));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('should make a key and a certificate for it, which Apple and Android accept as a server certificate', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const { certificate, created } = await loadSelfSignedCertificate(join(folder, 'tls'), now);

    expect(created).toBe('key');
    const x509 = new X509Certificate(certificate.certificate);
    expect(x509.subject).toBe('CN=Immich');
    expect(x509.subjectAltName).toBe('DNS:immich');
    expect(x509.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    expect(x509.ca).toBe(false);
    expect(x509.verify(x509.publicKey)).toBe(true);
    expect(x509.publicKey.asymmetricKeyDetails).toEqual({ namedCurve: 'prime256v1' });
    // at most 825 days (Apple)
    const lifetime = new Date(x509.validTo).getTime() - new Date(x509.validFrom).getTime();
    expect(lifetime).toBeLessThanOrEqual(CERTIFICATE_LIFETIME_DAYS * DAY_MS);
    expect(new Date(x509.validFrom).getTime()).toBeLessThan(now.getTime());

    // the pin is of the public key, the same from the key and from the certificate
    expect(certificate.pin).toBe(getPin(certificate.certificate));
    expect(certificate.pin).toBe(getPin(certificate.key));
    expect(Buffer.from(certificate.pin, 'base64')).toHaveLength(32);
    expect(readPin(join(folder, 'tls'))).toBe(certificate.pin);

    // only for this user
    expect(statSync(join(folder, 'tls')).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, 'tls', 'key.pem')).mode & 0o777).toBe(0o600);
  });

  it('should keep the key and the certificate while it is valid long enough', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const first = await loadSelfSignedCertificate(folder, now);
    const later = new Date(now.getTime() + 100 * DAY_MS);

    const second = await loadSelfSignedCertificate(folder, later);

    expect(second.created).toBe(false);
    expect(second.certificate).toEqual(first.certificate);
  });

  it('should make a new certificate for the same key when it is about to end, which keeps the pin', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const first = await loadSelfSignedCertificate(folder, now);
    const later = new Date(first.certificate.notAfter.getTime() - (CERTIFICATE_RENEW_DAYS - 1) * DAY_MS);

    const renewed = await loadSelfSignedCertificate(folder, later);

    expect(renewed.created).toBe('certificate');
    expect(renewed.certificate.certificate).not.toBe(first.certificate.certificate);
    expect(renewed.certificate.key).toBe(first.certificate.key);
    expect(renewed.certificate.pin).toBe(first.certificate.pin);
    expect(renewed.certificate.notAfter.getTime()).toBeGreaterThan(first.certificate.notAfter.getTime());
  });

  it('should make the certificate again when it is missing or of another key', async () => {
    const { certificate } = await loadSelfSignedCertificate(folder);
    const other = await loadSelfSignedCertificate(join(folder, 'other'));
    writeFileSync(join(folder, 'certificate.pem'), other.certificate.certificate);

    const repaired = await loadSelfSignedCertificate(folder);

    expect(repaired.created).toBe('certificate');
    expect(repaired.certificate.pin).toBe(certificate.pin);
    expect(getPin(readFileSync(join(folder, 'certificate.pem'), 'utf8'))).toBe(certificate.pin);

    rmSync(join(folder, 'certificate.pem'));
    const remade = await loadSelfSignedCertificate(folder);
    expect(remade.created).toBe('certificate');
  });

  it('should have no pin before the server made the key', () => {
    expect(readPin(folder)).toBeUndefined();
  });

  it('should show the pin as 16 groups of 4 hexadecimal digits', () => {
    const pin = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('base64');
    expect(formatPin(pin)).toBe('0001 0203 0405 0607 0809 0A0B 0C0D 0E0F 1011 1213 1415 1617 1819 1A1B 1C1D 1E1F');
  });

  it('should keep the key in the media location unless configured', () => {
    expect(getTlsLocation({}, '/data')).toBe('/data/tls');
    expect(getTlsLocation({ location: '/secrets/tls' }, '/data')).toBe('/secrets/tls');
  });
});
