import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const LoginCodeResponseSchema = z
  .object({
    url: z
      .string()
      .describe('What the QR code holds: a link that the mobile app opens to sign in, with the server and the code'),
    server: z.string().describe('The server the mobile app signs in to: the external domain'),
    expiresAt: z.iso.datetime().describe('When the code expires, unless it was used before'),
  })
  .meta({ id: 'LoginCodeResponseDto' });

const LoginCodeSchema = z
  .object({
    code: z.string().min(1).describe('The one-time code of the QR code'),
  })
  .meta({ id: 'LoginCodeDto' });

export class LoginCodeResponseDto extends createZodDto(LoginCodeResponseSchema) {}
export class LoginCodeDto extends createZodDto(LoginCodeSchema) {}
