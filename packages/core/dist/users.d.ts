export interface User {
    id: string;
    email: string;
    displayName: string | null;
    isAdmin: boolean;
    createdAt: Date;
    lastLoginAt: Date | null;
}
export interface UserSession {
    id: string;
    userId: string;
    token: string;
    expiresAt: Date;
}
export declare function hashPassword(password: string): Promise<string>;
export declare function verifyPassword(password: string, stored: string): Promise<boolean>;
export declare function userCount(): Promise<number>;
export declare function createUser(input: {
    email: string;
    password: string;
    displayName?: string;
    isAdmin?: boolean;
}): Promise<User>;
export declare function getUserByEmail(email: string): Promise<(User & {
    passwordHash: string;
}) | null>;
export declare function getUserById(id: string): Promise<User | null>;
export declare function authenticate(email: string, password: string): Promise<User | null>;
export declare function generateSessionToken(): string;
export declare function hashSessionToken(token: string): string;
export declare function createSession(userId: string, opts?: {
    userAgent?: string;
    ipAddress?: string;
}): Promise<UserSession>;
export declare function validateSession(token: string): Promise<User | null>;
export declare function revokeSession(token: string): Promise<void>;
export declare function adoptOrphanProfiles(userId: string): Promise<number>;
//# sourceMappingURL=users.d.ts.map