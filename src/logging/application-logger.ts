type LogDetails = Record<string, unknown>;

interface SerializedError {
  name: string;
  message: string;
  cause?: SerializedError;
}

function serializeError(error: unknown, depth = 0): SerializedError {
  if (error instanceof Error) {
    const serialized: SerializedError = {
      name: error.name,
      message: error.message,
    };

    if (error.cause !== undefined && depth < 3) {
      serialized.cause = serializeError(error.cause, depth + 1);
    }

    return serialized;
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
