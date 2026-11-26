export const EXPECTED_SCHEMA: Record<
  string,
  {
    columns?: Record<string, string>;
    constraints?: string[];
    indexes?: string[];
    forbidForeignKeys?: boolean;
  }
>;
export function verifySchema(
  query: (text: string) => Promise<Record<string, any>[]>,
): Promise<{ ok: boolean; problems: string[] }>;
