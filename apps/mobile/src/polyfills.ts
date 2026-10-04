// @noble reads crypto.getRandomValues from the global scope. Hermes may not
// provide it, so back it with expo-crypto (the OS's secure generator).
import { getRandomValues } from "expo-crypto";

const scope = globalThis as unknown as { crypto?: { getRandomValues?: typeof getRandomValues } };
if (!scope.crypto) scope.crypto = {};
if (!scope.crypto.getRandomValues) scope.crypto.getRandomValues = getRandomValues;
