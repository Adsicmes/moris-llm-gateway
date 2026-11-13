/** 运行时本地实现，确保 dist/index.js 不依赖包外 SDK 源码。 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code = 'provider_error',
    public readonly status = 502,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
