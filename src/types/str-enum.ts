/**
 * Utility to create a string enum object { K: K } from a list of string literals.
 * The resulting object and its keyof type serve as a single source of truth for
 * string-keyed discriminated unions, enabling exhaustiveness checks on switch
 * statements that process those unions.
 *
 * @example
 * const Colors = strEnum(['red', 'green', 'blue']);
 * type Color = keyof typeof Colors; // 'red' | 'green' | 'blue'
 *
 * @see https://typescript-jp.gitbook.io/deep-dive/type-system/literal-types
 */
export function strEnum<T extends string>(o: T[]): { [K in T]: K } {
  return o.reduce<{ [K in T]: K }>((res, key) => {
    res[key] = key;
    return res;
  }, Object.create(null));
}
