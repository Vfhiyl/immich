import { Command, CommandRunner, InquirerService } from 'nest-commander';
import { toString as toQrCode } from 'qrcode';
import { CliService } from 'src/services/cli.service.js';
import { formatPin } from 'src/utils/tls.js';

@Command({
  name: 'login-code',
  description:
    "Show a QR code that signs a user's phone in (by email), with the key of the HTTPS port in self-signed mode",
})
export class LoginCodeCommand extends CommandRunner {
  constructor(
    private service: CliService,
    private inquirer: InquirerService,
  ) {
    super();
  }

  async run(): Promise<void> {
    try {
      const { email } = await this.inquirer.ask<{ email: string }>('prompt-email', {});
      const { url, server, pin, expiresAt } = await this.service.createLoginCode(email);
      console.log(await toQrCode(url, { type: 'terminal', small: true }));
      console.log(`Scan it with the Immich app to sign ${email} in to ${server}, once, until ${expiresAt}.`);
      if (pin) {
        console.log(`The app shows the key of the server, which must be:\n${formatPin(pin)}`);
      }
    } catch (error) {
      console.error(error);
      console.error('Unable to create a code to sign in');
    }
  }
}
