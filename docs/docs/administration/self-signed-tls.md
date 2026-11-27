# Self-signed HTTPS (no domain)

Without a domain and a public certificate (for example a server with only a public IP address, or a NAS at home), the
server can secure the mobile app's connections with a certificate of its own. Phones are signed in with a QR code that
also holds the server's public key; the app trusts that key, and only that key, from then on. Nothing has to be
installed on the phones, and the server can be reached by any address.

With a domain, use a [reverse proxy](./reverse-proxy.md) with a public certificate instead: self-signed mode has no web
app on the public port.

## How it works

The server has two ports:

| Port                       | Protocol                         | For                                                                                               |
| :------------------------- | :------------------------------- | :------------------------------------------------------------------------------------------------ |
| `IMMICH_PORT` (2283)       | HTTPS, with the server's own key | the mobile app only: no web app, no administration, no password or OAuth sign-in, no shared links |
| `IMMICH_ADMIN_PORT` (2284) | HTTP                             | the web app and the administration, for this machine only; from elsewhere through an SSH tunnel   |

- On its first start the server makes a key and a certificate in `IMMICH_TLS_LOCATION` (by default `tls` in the media
  location), readable only by the server. Keep the key: with a new key every phone has to be signed in again. The
  certificate is valid for 825 days and is made again with the same key before it ends, which changes nothing for the
  phones.
- Users sign in only with a QR code that an administrator shows (_Users_ → a user → _Sign in a phone_, or the
  [`login-code` command](./server-commands.md)). Besides a one-time code, the QR code holds the SHA-256 of the
  server's public key. The app shows the key before it signs in: it must be the one the administrator sees.
- The key is also in the server's log at every start (`Public key of the HTTPS port (SHA-256): …`).
- Set the external domain (_Administration_ → _Settings_ → _Server_) to the address phones reach the HTTPS port by,
  e.g. `https://203.0.113.7:2283`: it is the address in the QR code.

## Setting up

Add to the `.env` file:

```bash
IMMICH_SELF_SIGNED_TLS=true
```

In `docker-compose.yml`, publish the administration port on this machine only, and keep the HTTPS port as it is:

```yaml
services:
  immich-server:
    environment:
      # inside the container: the port is published on this machine only, below
      IMMICH_ADMIN_HOST: 0.0.0.0
    ports:
      - '2283:2283'
      - '127.0.0.1:2284:2284'
```

:::danger
Publish the administration port as `127.0.0.1:2284:2284`, never as `2284:2284`: it is plain HTTP with the
administration on it. Inside a container the server cannot tell; outside Docker it listens on `127.0.0.1` unless
`IMMICH_ADMIN_HOST` says otherwise.
:::

## Administering from elsewhere

Open an SSH tunnel to the server and use the web app in a browser of your computer:

```bash
ssh -L 2284:127.0.0.1:2284 user@your-server
# then open http://localhost:2284
```

SSH makes sure that it is your server you talk to, so the QR codes you show from there are the server's. To sign a
phone in without a browser, run the [`login-code` command](./server-commands.md) on the server: it prints the QR code
in the terminal.

## Showing the QR code to a user

The QR code signs in whoever scans it first, within ten minutes, and tells the phone which key to trust. Show it in
person if you can. If you send a picture of it instead, compare the key the app shows with the one on your screen (for
example on a call) before the user confirms it.
