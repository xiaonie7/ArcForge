const DATABASE_TOOL_NAMES = new Set(["DatabaseQuery", "DatabaseExecute"]);

export const REDACTED_DATABASE_PASSWORD = "[redacted credential]";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
    ? (value as Record<string, unknown>)
    : undefined;
}

export function redactDatabaseToolArguments(
  toolName: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (!DATABASE_TOOL_NAMES.has(toolName)) return value;
  const connection = asRecord(value.connection);
  if (!connection || !("password" in connection)) return value;
  return {
    ...value,
    connection: {
      ...connection,
      password: REDACTED_DATABASE_PASSWORD,
    },
  };
}

export function redactDatabaseToolArgumentsInPlace(
  toolName: string,
  value: Record<string, unknown>,
) {
  if (!DATABASE_TOOL_NAMES.has(toolName)) return;
  const connection = asRecord(value.connection);
  if (connection && "password" in connection) {
    connection.password = REDACTED_DATABASE_PASSWORD;
  }
}

/**
 * History messages are otherwise persisted verbatim. Only recurse to locate
 * actual database tool-call blocks; user and Skill text remains untouched.
 */
export function redactDatabaseSecretsForPersistence<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactDatabaseSecretsForPersistence(item)) as T;
  }
  const record = asRecord(value);
  if (!record) return value;

  const out = Object.fromEntries(
    Object.entries(record).map(([key, nested]) => [
      key,
      redactDatabaseSecretsForPersistence(nested),
    ]),
  );
  if (out.type === "toolCall" && typeof out.name === "string" && asRecord(out.arguments)) {
    out.arguments = redactDatabaseToolArguments(out.name, out.arguments as Record<string, unknown>);
  }
  return out as T;
}
