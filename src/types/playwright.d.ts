declare module "playwright" {
  export const chromium: {
    launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<any>;
  };
}
