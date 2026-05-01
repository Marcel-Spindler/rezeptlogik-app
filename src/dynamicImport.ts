const RETRY_PREFIX = "dynamic-import-retry:";

export async function loadDynamicModule<T>(key: string, loader: () => Promise<T>): Promise<T> {
  try {
    const module = await loader();
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(`${RETRY_PREFIX}${key}`);
    }
    return module;
  } catch (error) {
    if (typeof window !== "undefined") {
      const retryKey = `${RETRY_PREFIX}${key}`;
      const retried = window.sessionStorage.getItem(retryKey) === "1";
      if (!retried) {
        window.sessionStorage.setItem(retryKey, "1");
        window.location.reload();
        return new Promise<T>(() => {});
      }
      window.sessionStorage.removeItem(retryKey);
    }
    throw error;
  }
}