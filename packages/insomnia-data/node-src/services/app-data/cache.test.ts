import { database } from 'insomnia-data';
import { servicesNodeImpl } from 'insomnia-data/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCachedAppDataService } from './cache';

describe('createCachedAppDataService', () => {
  beforeEach(async () => {
    await database.init({ inMemoryOnly: true }, true);
  });

  it('only computes organization data once and use cache data later', async () => {
    const getOrganizationDataSpy = vi.spyOn(servicesNodeImpl.appData, 'getOrganizationData');
    const cached = createCachedAppDataService(servicesNodeImpl.appData, database);

    const project = await servicesNodeImpl.project.create({ parentId: 'org_test' });
    const organizationId = project.parentId;

    const first = await cached.getOrganizationData(organizationId);
    const second = await cached.getOrganizationData(organizationId);

    expect(getOrganizationDataSpy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first.projects.map(p => p._id)).toContain(project._id);
  });

  it('invalidates the organization cache when a new project is created', async () => {
    const cached = createCachedAppDataService(servicesNodeImpl.appData, database);
    const project = await servicesNodeImpl.project.create({ parentId: 'org_test' });
    const organizationId = project.parentId;

    await cached.getOrganizationData(organizationId);

    const secondProject = await servicesNodeImpl.project.create({ parentId: organizationId });

    const refreshed = await cached.getOrganizationData(organizationId);
    expect(refreshed.projects.map(p => p._id)).toContain(secondProject._id);
  });

  it('patches the organization cache in place on workspaceMeta updates, without recomputing', async () => {
    const getOrganizationDataSpy = vi.spyOn(servicesNodeImpl.appData, 'getOrganizationData');
    const cached = createCachedAppDataService(servicesNodeImpl.appData, database);

    const project = await servicesNodeImpl.project.create({ parentId: 'org_test' });
    const organizationId = project.parentId;
    const workspace = await servicesNodeImpl.workspace.create({ parentId: project._id });

    await cached.getOrganizationData(organizationId);
    expect(getOrganizationDataSpy).toHaveBeenCalledTimes(1);

    const workspaceMeta = await servicesNodeImpl.workspaceMeta.getOrCreateByParentId(workspace._id);
    await servicesNodeImpl.workspaceMeta.update(workspaceMeta, { activeRequestId: 'req_123' });

    const refreshed = await cached.getOrganizationData(organizationId);
    expect(getOrganizationDataSpy).toHaveBeenCalledTimes(1);
    expect(refreshed.workspaceMetas.find(wm => wm.parentId === workspace._id)?.activeRequestId).toBe('req_123');
  });

  it('pushes an update when a fetchQuery refetch resolves', async () => {
    const onUpdate = vi.fn();
    const cached = createCachedAppDataService(servicesNodeImpl.appData, database, onUpdate);
    const project = await servicesNodeImpl.project.create({ parentId: 'org_test' });
    const organizationId = project.parentId;

    await cached.getOrganizationData(organizationId);
    expect(onUpdate).toHaveBeenCalledWith(
      ['organization-data', organizationId],
      expect.objectContaining({
        projects: expect.arrayContaining([expect.objectContaining({ _id: project._id })]),
      }),
    );

    onUpdate.mockClear();
    const secondProject = await servicesNodeImpl.project.create({ parentId: organizationId });
    await cached.getOrganizationData(organizationId);

    expect(onUpdate).toHaveBeenCalledWith(
      ['organization-data', organizationId],
      expect.objectContaining({
        projects: expect.arrayContaining([expect.objectContaining({ _id: secondProject._id })]),
      }),
    );
  });

  it('pushes an update when a workspaceMeta change patches the cache in place', async () => {
    const onUpdate = vi.fn();
    const cached = createCachedAppDataService(servicesNodeImpl.appData, database, onUpdate);

    const project = await servicesNodeImpl.project.create({ parentId: 'org_test' });
    const organizationId = project.parentId;
    const workspace = await servicesNodeImpl.workspace.create({ parentId: project._id });

    await cached.getOrganizationData(organizationId);
    onUpdate.mockClear();

    const workspaceMeta = await servicesNodeImpl.workspaceMeta.getOrCreateByParentId(workspace._id);
    await servicesNodeImpl.workspaceMeta.update(workspaceMeta, { activeRequestId: 'req_123' });

    expect(onUpdate).toHaveBeenCalledWith(
      ['organization-data', organizationId],
      expect.objectContaining({
        workspaceMetas: expect.arrayContaining([expect.objectContaining({ activeRequestId: 'req_123' })]),
      }),
    );
  });

  it('invalidates only the affected workspace when a request moves to a new parent', async () => {
    const cached = createCachedAppDataService(servicesNodeImpl.appData, database);
    const workspaceA = await servicesNodeImpl.workspace.create();
    const workspaceB = await servicesNodeImpl.workspace.create();
    const request = await servicesNodeImpl.request.create({ parentId: workspaceA._id });

    const beforeMove = await cached.getWorkspaceChildren([workspaceA._id, workspaceB._id], 'collection');
    expect(beforeMove.get(workspaceA._id)?.children.requestsAndGroups.map(r => r._id)).toContain(request._id);
    expect(beforeMove.get(workspaceB._id)?.children.requestsAndGroups.map(r => r._id)).not.toContain(request._id);

    await servicesNodeImpl.request.update(request, { parentId: workspaceB._id });

    const afterMove = await cached.getWorkspaceChildren([workspaceA._id, workspaceB._id], 'collection');
    expect(afterMove.get(workspaceA._id)?.children.requestsAndGroups.map(r => r._id)).not.toContain(request._id);
    expect(afterMove.get(workspaceB._id)?.children.requestsAndGroups.map(r => r._id)).toContain(request._id);
  });

  describe('workspaceMeta add/remove', () => {
    it('adds a new workspaceMeta to the organization cache in place, without recomputing', async () => {
      const getOrganizationDataSpy = vi.spyOn(servicesNodeImpl.appData, 'getOrganizationData');
      const cached = createCachedAppDataService(servicesNodeImpl.appData, database);

      const project = await servicesNodeImpl.project.create({ parentId: 'org_test' });
      const organizationId = project.parentId;
      const workspace = await servicesNodeImpl.workspace.create({ parentId: project._id });

      await cached.getOrganizationData(organizationId);
      expect(getOrganizationDataSpy).toHaveBeenCalledTimes(1);

      const workspaceMeta = await servicesNodeImpl.workspaceMeta.create({ parentId: workspace._id });

      const refreshed = await cached.getOrganizationData(organizationId);
      expect(getOrganizationDataSpy).toHaveBeenCalledTimes(1);
      expect(refreshed.workspaceMetas.map(wm => wm._id)).toContain(workspaceMeta._id);
    });

    it('removes a deleted workspaceMeta from the organization cache in place, without recomputing', async () => {
      const getOrganizationDataSpy = vi.spyOn(servicesNodeImpl.appData, 'getOrganizationData');
      const cached = createCachedAppDataService(servicesNodeImpl.appData, database);

      const project = await servicesNodeImpl.project.create({ parentId: 'org_test' });
      const organizationId = project.parentId;
      const workspace = await servicesNodeImpl.workspace.create({ parentId: project._id });
      const workspaceMeta = await servicesNodeImpl.workspaceMeta.getOrCreateByParentId(workspace._id);

      await cached.getOrganizationData(organizationId);
      expect(getOrganizationDataSpy).toHaveBeenCalledTimes(1);

      await database.remove(workspaceMeta);

      const refreshed = await cached.getOrganizationData(organizationId);
      expect(getOrganizationDataSpy).toHaveBeenCalledTimes(1);
      expect(refreshed.workspaceMetas.map(wm => wm._id)).not.toContain(workspaceMeta._id);
    });
  });

  describe('collection children update', () => {
    it('create request group, websocket request and grpc request', async () => {
      const cached = createCachedAppDataService(servicesNodeImpl.appData, database);
      const workspace = await servicesNodeImpl.workspace.create();

      const before = await cached.getWorkspaceChildren([workspace._id], 'collection');
      expect(before.get(workspace._id)?.children.requestsAndGroups).toHaveLength(0);

      const requestGroup = await servicesNodeImpl.requestGroup.create({ parentId: workspace._id });
      const webSocketRequest = await servicesNodeImpl.webSocketRequest.create({ parentId: workspace._id });
      const grpcRequest = await servicesNodeImpl.grpcRequest.create({ parentId: workspace._id });

      const after = await cached.getWorkspaceChildren([workspace._id], 'collection');
      const ids = after.get(workspace._id)?.children.requestsAndGroups.map(r => r._id) || [];
      expect(ids).toEqual(expect.arrayContaining([requestGroup._id, webSocketRequest._id, grpcRequest._id]));
    });

    it('patches a webSocketRequest update in place without invalidating the workspace cache', async () => {
      const onUpdate = vi.fn();
      const cached = createCachedAppDataService(servicesNodeImpl.appData, database, onUpdate);
      const workspace = await servicesNodeImpl.workspace.create();
      const webSocketRequest = await servicesNodeImpl.webSocketRequest.create({ parentId: workspace._id });

      await cached.getWorkspaceChildren([workspace._id], 'collection');
      onUpdate.mockClear();

      await servicesNodeImpl.webSocketRequest.update(webSocketRequest, { name: 'renamed' });

      expect(onUpdate).toHaveBeenCalledWith(
        expect.arrayContaining([workspace._id]),
        expect.objectContaining({
          children: expect.objectContaining({
            requestsAndGroups: expect.arrayContaining([
              expect.objectContaining({ _id: webSocketRequest._id, name: 'renamed' }),
            ]),
          }),
        }),
      );
    });

    it('reflects a requestGroup removal on the next fetch', async () => {
      const cached = createCachedAppDataService(servicesNodeImpl.appData, database);
      const workspace = await servicesNodeImpl.workspace.create();
      const requestGroup = await servicesNodeImpl.requestGroup.create({ parentId: workspace._id });

      const before = await cached.getWorkspaceChildren([workspace._id], 'collection');
      expect(before.get(workspace._id)?.children.requestsAndGroups.map(r => r._id)).toContain(requestGroup._id);

      await servicesNodeImpl.requestGroup.remove(requestGroup);

      const after = await cached.getWorkspaceChildren([workspace._id], 'collection');
      expect(after.get(workspace._id)?.children.requestsAndGroups.map(r => r._id)).not.toContain(requestGroup._id);
    });
  });

  describe('non-collection workspace children update (mock server)', () => {
    it('reflects a mockServer addition for a mock-server scoped workspace on the next fetch', async () => {
      const cached = createCachedAppDataService(servicesNodeImpl.appData, database);
      const workspace = await servicesNodeImpl.workspace.create({ scope: 'mock-server' });

      const before = await cached.getWorkspaceChildren([workspace._id], 'mock-server');
      expect(before.get(workspace._id)?.children.mockServer).toBeUndefined();

      const mockServer = await servicesNodeImpl.mockServer.create({ parentId: workspace._id });

      const after = await cached.getWorkspaceChildren([workspace._id], 'mock-server');
      expect(after.get(workspace._id)?.children.mockServer?._id).toBe(mockServer._id);
    });

    it('invalidates the cache and pushes an update when a mockServer is updated', async () => {
      const onUpdate = vi.fn();
      const cached = createCachedAppDataService(servicesNodeImpl.appData, database, onUpdate);
      const workspace = await servicesNodeImpl.workspace.create({ scope: 'mock-server' });
      const mockServer = await servicesNodeImpl.mockServer.create({ parentId: workspace._id });

      await cached.getWorkspaceChildren([workspace._id], 'mock-server');
      onUpdate.mockClear();

      await servicesNodeImpl.mockServer.update(mockServer, { name: 'renamed-mock' });

      // The mockServer update invalidates (rather than patches in place) the workspace cache,
      // so the refreshed data is only observable once it's re-fetched.
      const refreshed = await cached.getWorkspaceChildren([workspace._id], 'mock-server');
      expect(refreshed.get(workspace._id)?.children.mockServer?.name).toBe('renamed-mock');

      expect(onUpdate).toHaveBeenCalledWith(
        expect.arrayContaining([workspace._id]),
        expect.objectContaining({
          children: expect.objectContaining({
            mockServer: expect.objectContaining({ _id: mockServer._id, name: 'renamed-mock' }),
          }),
        }),
      );
    });

    it('reflects a mockServer removal on the next fetch', async () => {
      const cached = createCachedAppDataService(servicesNodeImpl.appData, database);
      const workspace = await servicesNodeImpl.workspace.create({ scope: 'mock-server' });
      const mockServer = await servicesNodeImpl.mockServer.create({ parentId: workspace._id });

      const before = await cached.getWorkspaceChildren([workspace._id], 'mock-server');
      expect(before.get(workspace._id)?.children.mockServer?._id).toBe(mockServer._id);

      await servicesNodeImpl.mockServer.remove(mockServer);

      const after = await cached.getWorkspaceChildren([workspace._id], 'mock-server');
      expect(after.get(workspace._id)?.children.mockServer).toBeUndefined();
    });
  });
});
