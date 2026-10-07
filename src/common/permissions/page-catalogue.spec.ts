import { PAGE_CATALOGUE, STAFF_ROLES } from './page-catalogue';
import { PERMISSION_MODULES } from './permission-catalogue';

const MODULES = new Set(PERMISSION_MODULES.map((module) => module.key));

describe('PAGE_CATALOGUE', () => {
  it('names each page once, by its path in the web app', () => {
    const keys = PAGE_CATALOGUE.map((page) => page.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^\/dashboard\/[a-z0-9/-]+$/);
  });

  it('only names modules that exist, and a page always uses its own', () => {
    for (const page of PAGE_CATALOGUE) {
      if (page.module !== null) {
        expect(MODULES.has(page.module)).toBe(true);
        expect(page.uses).toContain(page.module);
      }
      for (const module of page.uses) expect(MODULES.has(module)).toBe(true);
    }
  });

  it('gives pages only to staff roles, and acting is a subset of opening', () => {
    for (const page of PAGE_CATALOGUE) {
      for (const role of page.roles) expect(STAFF_ROLES).toContain(role);
      for (const role of page.actRoles ?? []) expect(page.roles).toContain(role);
    }
  });

  it('every staff role has something to open', () => {
    for (const role of STAFF_ROLES) expect(PAGE_CATALOGUE.some((page) => page.roles.includes(role))).toBe(true);
  });
});
