import { Controller, Delete, Head, Options, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { ResumableUploadResponse, ResumableUploadService } from 'src/services/resumable-upload.service.js';
import { UUIDParamDto } from 'src/validation.js';

const send = (res: Response, { status, headers, body }: ResumableUploadResponse) => {
  res.status(status).set(headers);
  if (body === undefined) {
    res.end();
  } else if (headers['Content-Type']) {
    res.send(JSON.stringify(body));
  } else {
    res.json(body);
  }
};

/** A `104 (Upload Resumption Supported)` interim response, which Express cannot send, written to the connection */
const sendInterim = (req: Request, res: Response) => (headers: Record<string, string>) => {
  if (req.httpVersion !== '1.1' || res.headersSent || !res.socket || res.socket.destroyed) {
    return;
  }
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  res.socket.write(`HTTP/1.1 104 Upload Resumption Supported\r\n${lines.join('\r\n')}\r\n\r\n`);
};

/**
 * Resumable uploads (draft-ietf-httpbis-resumable-upload), which the draft describes rather than the API description:
 * the content is the file itself, and the asset is described by the `X-Immich-Asset-Data` header of the creation
 */
@ApiExcludeController()
@Controller('upload')
export class ResumableUploadController {
  constructor(private service: ResumableUploadService) {}

  // a preflight, which clients may send before they authenticate; it only tells the limits
  @Options()
  @Authenticated({ public: true })
  getUploadOptions(@Res() res: Response) {
    send(res, this.service.getOptions());
  }

  @Post()
  @Authenticated({ permission: Permission.AssetUpload })
  async createUpload(@Auth() auth: AuthDto, @Req() req: Request, @Res() res: Response) {
    send(
      res,
      await this.service.createUpload({ auth, headers: req.headers, body: req, sendInterim: sendInterim(req, res) }),
    );
  }

  @Head(':id')
  @Authenticated({ permission: Permission.AssetUpload })
  async getUpload(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Res() res: Response) {
    send(res, await this.service.getUpload(auth, id));
  }

  @Patch(':id')
  @Authenticated({ permission: Permission.AssetUpload })
  async appendUpload(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Req() req: Request, @Res() res: Response) {
    send(res, await this.service.appendUpload(id, { auth, headers: req.headers, body: req }));
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.AssetUpload })
  async cancelUpload(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Res() res: Response) {
    send(res, await this.service.cancelUpload(auth, id));
  }
}
