import { BadRequestException } from '@nestjs/common';
import { PERMISSION_ACTIONS, PERMISSION_MODULES, actionForMethod, parsePermissions, permits } from './permission-catalogue';

describe('permission-catalogue', () => {
  describe('what can be delegated', () => {
    it('has no module for staff, roles, security, system administration, backups, GDPR or integrations', () => {
      const keys = PERMISSION_MODULES.map((module) => module.key);
      for (const forbidden of ['staff', 'users', 'roles', 'permissions', 'security', 'audit', 'gdpr', 'system', 'backups', 'integrations', 'tenants']) {
        expect(keys).not.toContain(forbidden);
      }
    });

    it('describes every module it offers', () => {
      expect(PERMISSION_MODULES.every((module) => module.label.length > 0 && module.description.length > 10)).toBe(true);
      expect(new Set(PERMISSION_MODULES.map((m) => m.key)).size).toBe(PERMISSION_MODULES.length);
    });
  });

  describe('parsePermissions', () => {
    it('accepts an empty map — a role that can do nothing until it is scoped', () => {
      expect(parsePermissions({})).toEqual({});
      expect(parsePermissions(null)).toEqual({});
    });

    it('keeps what it is given, without duplicates, and drops empty modules', () => {
      expect(parsePermissions({ reservations: ['read', 'read', 'update'], pos: [] })).toEqual({ reservations: ['read', 'update'] });
    });

    it('refuses a module nobody offers, rather than ignoring it', () => {
      expect(() => parsePermissions({ staff: ['read'] })).toThrow(/isn’t something a role can be given/);
      expect(() => parsePermissions({ reservations: ['approve'] })).toThrow(/isn’t an action/);
      expect(() => parsePermissions({ reservations: 'read' })).toThrow(BadRequestException);
      expect(() => parsePermissions([])).toThrow(BadRequestException);
    });
  });

  it('reads a permission back', () => {
    const map = parsePermissions({ folios: ['read', 'create'] });
    expect(permits(map, 'folios', 'create')).toBe(true);
    expect(permits(map, 'folios', 'delete')).toBe(false);
    expect(permits(map, 'pos', 'read')).toBe(false);
  });

  it('maps an HTTP method to an action', () => {
    expect(actionForMethod('GET')).toBe('read');
    expect(actionForMethod('post')).toBe('create');
    expect(actionForMethod('PUT')).toBe('update');
    expect(actionForMethod('PATCH')).toBe('update');
    expect(actionForMethod('DELETE')).toBe('delete');
    // Anything else reads rather than writes — the safe direction for a guard.
    expect(actionForMethod('HEAD')).toBe('read');
    expect(PERMISSION_ACTIONS).toEqual(['read', 'create', 'update', 'delete']);
  });
});
