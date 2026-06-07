/**
 * RBAC scopes (spec Phase 3). Scopes are "<resource>:<verb>" strings; roles
 * are named scope sets; principals carry roles. "*" grants everything and a
 * "<resource>:*" wildcard grants all verbs on one resource.
 *
 * Local-first defaults: the loopback operator holds "*". Remote principals
 * (Phase 5 auth portal) will resolve from API keys; the check surface is the
 * same either way.
 */

export type Scope = string;

export interface Principal {
  id: string;
  name: string;
  roles: string[];
}

export const DEFAULT_ROLES: Record<string, Scope[]> = {
  operator: ["*"],
  approver: ["approvals:read", "approvals:decide", "traces:read", "audit:read"],
  viewer: [
    "agents:read",
    "sessions:read",
    "traces:read",
    "budget:read",
    "approvals:read",
    "audit:read",
    "schedule:read",
    "workflows:read",
    "skills:read",
  ],
};

export const OPERATOR: Principal = { id: "local", name: "operator", roles: ["operator"] };

export class Rbac {
  private readonly roles: Map<string, Set<Scope>>;

  constructor(roles: Record<string, Scope[]> = DEFAULT_ROLES) {
    this.roles = new Map(Object.entries(roles).map(([name, scopes]) => [name, new Set(scopes)]));
  }

  scopesFor(principal: Principal): Set<Scope> {
    const scopes = new Set<Scope>();
    for (const role of principal.roles) {
      for (const scope of this.roles.get(role) ?? []) scopes.add(scope);
    }
    return scopes;
  }

  can(principal: Principal, required: Scope): boolean {
    const scopes = this.scopesFor(principal);
    if (scopes.has("*") || scopes.has(required)) return true;
    const colon = required.indexOf(":");
    return colon > 0 && scopes.has(`${required.slice(0, colon)}:*`);
  }
}
