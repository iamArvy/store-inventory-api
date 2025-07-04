import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { SessionRepo } from 'src/db/repositories/session.repo';
import { UserRepo } from 'src/db/repositories/user.repo';
import { AuthResponse, Status } from 'src/common/dto/app.response';
import { TokenService } from 'src/common/token/token.service';
import { SecretService } from 'src/common/secret/secret.service';
import { LoginData, RegisterData } from 'src/common/dto/app.inputs';
import { BaseService } from 'src/common/base/base.service';
import { UserEvent } from 'src/messsaging/event/user.event';
import { RoleRepo } from 'src/db/repositories/role.repo';

@Injectable()
export class AuthService extends BaseService {
  constructor(
    private userRepo: UserRepo,
    private sessionRepo: SessionRepo,
    private tokenService: TokenService,
    private secret: SecretService,
    private userEvent: UserEvent,
    private roleRepo: RoleRepo,
  ) {
    super();
  }

  private async issueTokens(
    sessionId: string,
    userId: string,
    storeId: string,
    emailVerified: boolean = false,
  ): Promise<AuthResponse> {
    const refreshToken =
      await this.tokenService.generateRefreshToken(sessionId);
    const accessToken = await this.tokenService.generateAccessToken(
      userId,
      storeId,
      emailVerified,
    );
    const hashed = await this.secret.create(refreshToken);
    await this.sessionRepo.updateRefreshToken(sessionId, hashed);

    return {
      access: {
        token: accessToken,
        expiresIn: 15 * 60 * 1000,
      },
      refresh: {
        token: refreshToken,
        expiresIn: 7 * 24 * 60 * 60 * 1000,
      },
    };
  }

  private async authenticateUser(
    id: string,
    userAgent: string,
    ipAddress: string,
    newUser: boolean = false,
    storeId: string,
    emailVerified: boolean = false,
  ): Promise<AuthResponse> {
    try {
      const existingSession = await this.sessionRepo.findByUserIdAndDevice(
        id,
        userAgent,
        ipAddress,
      );

      if (existingSession) {
        return this.issueTokens(existingSession.id, id, storeId, emailVerified);
      }

      const session = await this.sessionRepo.create({
        user: { connect: { id } },
        userAgent,
        ipAddress,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      if (!newUser) {
        this.userEvent.newDeviceLogin({
          userId: id,
          userAgent,
          ipAddress,
        });
      }
      return this.issueTokens(session.id, id, storeId, emailVerified);
    } catch (error) {
      this.handleError(error, 'AuthService.authenticateUser');
    }
  }

  async signup(
    data: RegisterData,
    userAgent: string,
    ipAddress: string,
    storeId: string,
  ): Promise<AuthResponse> {
    try {
      if (!data) throw new UnauthorizedException('Invalid credentials');
      const exists = await this.userRepo.findByEmail(data.email);
      if (exists) throw new UnauthorizedException('User already exists');
      const hash = await this.secret.create(data.password);
      // on signup create a owner role for the store and assign it to the user
      const role = await this.roleRepo.create({
        name: 'owner',
        description: 'Owner of the store',
        storeId,
        RolePermissions: {
          create: {
            permission: {
              connect: { name: 'all' }, // Assuming 'all' permission exists
            },
          },
        },
      });
      if (!role) throw new UnauthorizedException('Role creation failed');
      const user = await this.userRepo.create({
        email: data.email,
        passwordHash: hash,
        storeId,
        role: { connect: { id: role.id } },
      });

      if (!user) throw new UnauthorizedException('User creation failed');

      this.userEvent.created({
        userId: user.id,
        email: user.email,
      });

      const token = await this.tokenService.generateEmailVerificationToken(
        user.id,
        user.email,
      );

      this.userEvent.emailVerificationRequested({
        token,
        email: user.email,
      });

      return this.authenticateUser(
        user.id,
        userAgent,
        ipAddress,
        true,
        storeId,
        false,
      );
    } catch (error) {
      this.handleError(error, 'AuthService.signup');
    }
  }

  async login(
    data: LoginData,
    userAgent: string,
    ipAddress: string,
  ): Promise<AuthResponse> {
    try {
      const user = await this.userRepo.findByEmail(data.email);
      if (!user) throw new UnauthorizedException('User not found');
      await this.secret.compare(user.passwordHash, data.password);
      return this.authenticateUser(
        user.id,
        userAgent,
        ipAddress,
        false,
        user.storeId,
        user.emailVerified,
      );
    } catch (error) {
      this.handleError(error, 'AuthService.login');
    }
  }

  async refreshToken(
    refresh_token: string,
  ): Promise<{ token: string; expiresIn: number }> {
    try {
      const { sub: id } = await this.tokenService.verifyToken<{
        sub: string;
      }>(refresh_token);
      const session = await this.sessionRepo.findById(id);
      if (!session || session.revokedAt) {
        throw new UnauthorizedException('Session not found or revoked');
      }
      if (session.expiresAt && session.expiresAt < new Date()) {
        throw new UnauthorizedException('Session expired');
      }

      // Check if the session's hashed refresh token matches the provided refresh token
      if (!session.hashedRefreshToken)
        throw new UnauthorizedException('Session has no refresh token');

      await this.secret.compare(session.hashedRefreshToken, refresh_token);

      const user = await this.userRepo.findById(session.id);
      if (!user) throw new NotFoundException('User not found');
      // Generate new tokens
      const accessToken = await this.tokenService.generateAccessToken(
        user.id,
        user.storeId,
        user.emailVerified,
        user.roleId,
      );
      return { token: accessToken, expiresIn: 60 * 15 * 1000 };
    } catch (error) {
      this.handleError(error, 'AuthService.refreshToken');
    }
  }

  async logout(token: string): Promise<Status> {
    try {
      const { sub } = await this.tokenService.verifyRefreshToken(token);
      const session = await this.sessionRepo.findById(sub);
      if (!session) throw new NotFoundException('Session not found');
      if (session.revokedAt) {
        throw new UnauthorizedException('Session already revoked');
      }
      await this.sessionRepo.update(session.id, {
        hashedRefreshToken: null,
        expiresAt: new Date(),
        revokedAt: new Date(),
      });
      return { success: true };
    } catch (error) {
      this.handleError(error, 'AuthService.logout');
    }
  }
}
