import { Injectable, OnModuleInit, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PERMISSION_KEY, PermissionMetadata } from '../decorators/permission.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PermissionAction, PermissionMap, actionForMethod } from './permission-catalogue';

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
};

/**
 * What each seeded role can actually do, read off the routes themselves at
 * start-up.
 *
 * The permission matrix shows this for the six seeded roles, so somebody
 * building a custom role can see what a real front-desk or accountant role
 * covers and start from it. Deriving it beats keeping a table of presets
 * beside the routes: a hand-written one drifts the first time a route's
 * `@Roles` changes, and a matrix that lies about who can do what is worse
 * than no matrix.
 */
@Injectable()
export class RoutePermissionMapService implements OnModuleInit {
  private presets: Record<string, PermissionMap> = {};

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    const presets: Record<string, Record<string, Set<PermissionAction>>> = {};

    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance) continue;
      const prototype = Object.getPrototypeOf(instance) as object;

      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler = (instance as Record<string, () => unknown>)[methodName];
        if (typeof handler !== 'function') continue;

        const roles = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [handler, wrapper.metatype as never]);
        const permission = this.reflector.getAllAndOverride<PermissionMetadata | undefined>(PERMISSION_KEY, [handler, wrapper.metatype as never]);
        if (!roles?.length || !permission) continue;

        const httpMethod = METHOD_NAMES[Reflect.getMetadata(METHOD_METADATA, handler) as number] ?? 'GET';
        const action = permission.action ?? actionForMethod(httpMethod);
        for (const role of roles) {
          presets[role] ??= {};
          presets[role][permission.module] ??= new Set<PermissionAction>();
          presets[role][permission.module].add(action);
        }
      }
    }

    this.presets = Object.fromEntries(
      Object.entries(presets).map(([role, modules]) => [
        role,
        Object.fromEntries(Object.entries(modules).map(([module, actions]) => [module, [...actions].sort()])),
      ]),
    );
  }

  /** `{ front_desk: { reservations: ['create','read','update'], … }, … }` */
  systemRolePresets(): Record<string, PermissionMap> {
    return this.presets;
  }
}
