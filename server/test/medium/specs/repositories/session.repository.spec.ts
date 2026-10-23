import { Kysely } from 'kysely';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getTestKyselyDB } from 'test/utils.js';

const setup = async () => {
  const db: Kysely<DB> = await getTestKyselyDB();
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, db, sut: ctx.get(SessionRepository) };
};

describe(SessionRepository.name, () => {
  describe('login codes', () => {
    it('should sign in with a code once, until it expires', async () => {
      const { sut, ctx } = await setup();
      const { user } = await ctx.newUser();
      const { user: admin } = await ctx.newUser();
      const code = Buffer.from('code');
      await sut.createLoginCode({
        code,
        userId: user.id,
        createdById: admin.id,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(sut.useLoginCode(Buffer.from('another code'))).resolves.toBeUndefined();
      await expect(sut.useLoginCode(code)).resolves.toBe(user.id);
      // used up
      await expect(sut.useLoginCode(code)).resolves.toBeUndefined();
    });

    it('should not sign in with a code that expired, and drop expired codes when a new one is created', async () => {
      const { sut, ctx, db } = await setup();
      const { user } = await ctx.newUser();
      const expired = Buffer.from('expired');
      await sut.createLoginCode({
        code: expired,
        userId: user.id,
        createdById: user.id,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(sut.useLoginCode(expired)).resolves.toBeUndefined();

      await sut.createLoginCode({
        code: Buffer.from('new'),
        userId: user.id,
        createdById: user.id,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const codes = await db.selectFrom('login_code').select('code').where('userId', '=', user.id).execute();
      expect(codes.map(({ code }) => code.toString())).toEqual(['new']);
    });

    it('should drop the codes of a user that is deleted', async () => {
      const { sut, ctx, db } = await setup();
      const { user } = await ctx.newUser();
      await sut.createLoginCode({
        code: Buffer.from('code'),
        userId: user.id,
        createdById: user.id,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await db.deleteFrom('user').where('id', '=', user.id).execute();

      await expect(db.selectFrom('login_code').selectAll().execute()).resolves.toEqual([]);
    });
  });
});
