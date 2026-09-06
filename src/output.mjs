export function decodeOutput(text) {
  const value = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
  // Some tool-output transports envelope the complete result in the function's subject field.
  // Unwrap only this exact lossless shape; validation still checks all sources and obligations.
  if (Object.keys(value).length === 1 && !Array.isArray(value.expectations)
      && Array.isArray(value.expectations?.expectations)
      && (Array.isArray(value.expectations?.decisions) || (Array.isArray(value.expectations?.human) && Array.isArray(value.expectations?.automation) && Array.isArray(value.expectations?.uncertain)))) {
    return value.expectations;
  }
  return value;
}
