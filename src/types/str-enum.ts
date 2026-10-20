/**
 * Create a `{ K: K }` object from string literals.
 * Use its keys as the source of truth for a discriminated union and check
 * switch statements for missing cases.
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
