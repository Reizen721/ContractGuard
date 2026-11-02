export class ProjectError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = 'ProjectError'; }
}
export function invalid(message: string): never { throw new ProjectError(400, 'INVALID_PROJECT_CONFIG', message); }
