import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-types";

export interface DiagnosticDelta {
  newErrors: Diagnostic[];
  resolvedErrors: Diagnostic[];
  unchanged: Diagnostic[];
}
export function diagnosticSignature(diagnostic: Diagnostic): string {
  return JSON.stringify([diagnostic.range.start.line, diagnostic.range.start.character, diagnostic.code ?? null, diagnostic.message]);
}
function indexErrors(diagnostics: readonly Diagnostic[]): Map<string, Diagnostic> {
  return new Map(diagnostics.filter(d => d.severity === DiagnosticSeverity.Error).map(d => [diagnosticSignature(d), d]));
}
function sorted(diagnostics: Map<string, Diagnostic>): Diagnostic[] {
  return [...diagnostics].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, d]) => structuredClone(d));
}
/** Error-only set comparison; duplicates count once. Positions are identity. */
export function calculateDelta(baselineDiagnostics: readonly Diagnostic[], stagedDiagnostics: readonly Diagnostic[]): DiagnosticDelta {
  const baseline = indexErrors(baselineDiagnostics);
  const staged = indexErrors(stagedDiagnostics);
  const newErrors = new Map<string, Diagnostic>();
  const resolvedErrors = new Map<string, Diagnostic>();
  const unchanged = new Map<string, Diagnostic>();
  for (const [key, diagnostic] of staged) (baseline.has(key) ? unchanged : newErrors).set(key, diagnostic);
  for (const [key, diagnostic] of baseline) if (!staged.has(key)) resolvedErrors.set(key, diagnostic);
  return { newErrors: sorted(newErrors), resolvedErrors: sorted(resolvedErrors), unchanged: sorted(unchanged) };
}
