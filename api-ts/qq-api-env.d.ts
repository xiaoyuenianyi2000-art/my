// 让 api-ts 编译器认识 qq-music-api 内部 sealedSession 模块（运行时由 Vercel 打包真实文件）。
// sealedSession.js 是 npm 包编译产物（无 .d.ts），这里只声明我们用到的最小表面。
declare module '@yakult-green-tea/qq-music-api/dist/src/serverless/sealedSession.js' {
    export const SEALED_AUTH_PURPOSE: string;
    export function sealToken(payload: unknown, purpose: string, secret: string): Promise<string>;
}
