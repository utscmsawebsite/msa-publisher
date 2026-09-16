type LogDetails = Record<string, unknown>;

function serializeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: "UnknownError",
    message: String(error),
  };
}

export function logInfo(event: string, details: LogDetails = {}): void {
  console.info(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      event,
      ...details,
    }),
  );
}

export function logWarning(event: string, details: LogDetails = {}): void {
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warning",
      event,
      ...details,
    }),
  );
}

export function logError(
  event: string,
  error: unknown,
  details: LogDetails = {},
): void {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event,
      ...details,
      error: serializeError(error),
    }),
  );
}
