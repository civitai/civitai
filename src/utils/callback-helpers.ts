type Callback<T> = (error: any, result: T) => void;

export function promisify<T>(fn: (...args: any[]) => void, ...args: any[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const callback: Callback<T> = (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    fn(...args, callback);
  });
}
