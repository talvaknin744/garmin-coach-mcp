let tail = Promise.resolve();

export async function withWriteLock<T>(action: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release: () => void = () => {};
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}
