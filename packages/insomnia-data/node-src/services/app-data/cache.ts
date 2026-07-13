import { QueryClient } from '@tanstack/query-core';
import type {
  BaseModel,
  ChangeBufferEvent,
  CollectionWorkspaceChildren,
  IDatabase,
  OrganizationData,
  WorkspaceChildren,
  WorkspaceChildrenForScope,
  WorkspaceMeta,
  WorkspaceScope,
} from 'insomnia-data';
import { models } from 'insomnia-data';
import { organizationDataKeys, workspaceChildrenKeys } from 'insomnia-data/common';

import type * as organizationDataModule from './organization-data';
import type * as workspaceDataModule from './workspace-data';

export type AppDataService = typeof organizationDataModule & typeof workspaceDataModule;

const COLLECTION_REQUEST_DOC_TYPES: string[] = [
  models.request.type,
  models.grpcRequest.type,
  models.webSocketRequest.type,
  models.socketIORequest.type,
  models.requestGroup.type,
];

const COLLECTION_REQUEST_META_DOC_TYPES: string[] = [
  models.requestMeta.type,
  models.grpcRequestMeta.type,
  models.webSocketRequestMeta.type,
  models.socketIORequestMeta.type,
];

const COLLECTION_CHILDREN_DOC_TYPES: string[] = [
  ...COLLECTION_REQUEST_DOC_TYPES,
  ...COLLECTION_REQUEST_META_DOC_TYPES,
  models.requestGroupMeta.type,
];

const WORKSPACE_CHILD_DOC_TYPES: string[] = [
  ...COLLECTION_CHILDREN_DOC_TYPES,
  models.mockServer.type,
  models.apiSpec.type,
  models.mcpRequest.type,
  models.environment.type,
];

const MONITOR_DOC_TYPES: string[] = [
  models.project.type,
  models.workspace.type,
  ...WORKSPACE_CHILD_DOC_TYPES,
  models.workspaceMeta.type,
];

function findOrganizationAndProjectIdForWorkspace(
  queryClient: QueryClient,
  doc: BaseModel,
): { organizationId: string; projectId: string } | undefined {
  const cached = queryClient.getQueriesData<OrganizationData>({ queryKey: organizationDataKeys.all });
  const { parentId } = doc;
  for (const [queryKey, data] of cached) {
    const project = data?.projects.find(p => p._id === parentId);
    if (project) {
      return { organizationId: queryKey[1] as string, projectId: project._id };
    }
  }
  return undefined;
}

function findOrganizationFromWorkspaceId(queryClient: QueryClient, workspaceId: string): string | undefined {
  const cached = queryClient.getQueriesData<OrganizationData>({ queryKey: organizationDataKeys.all });
  for (const [queryKey, data] of cached) {
    if (data?.workspaces.some(w => w._id === workspaceId)) {
      return queryKey[1] as string;
    }
  }
  return undefined;
}

function updateOrganizationDataWorkspaceMeta(
  queryClient: QueryClient,
  organizationId: string,
  workspaceMeta: BaseModel,
) {
  queryClient.setQueryData<OrganizationData>(organizationDataKeys.byOrganizationId(organizationId), previous => {
    if (previous) {
      const clonedWorkspaceMetas = [...previous.workspaceMetas];
      const workspaceMetaIdx = clonedWorkspaceMetas.findIndex(wm => wm._id === workspaceMeta._id);
      if (workspaceMetaIdx !== -1) {
        clonedWorkspaceMetas[workspaceMetaIdx] = workspaceMeta as WorkspaceMeta;
        return { ...previous, workspaceMetas: clonedWorkspaceMetas };
      }
    }
    return previous;
  });
}

function deleteOrganizationDataWorkspaceMeta(
  queryClient: QueryClient,
  organizationId: string,
  workspaceMeta: BaseModel,
) {
  queryClient.setQueryData<OrganizationData>(organizationDataKeys.byOrganizationId(organizationId), previous => {
    if (previous) {
      return { ...previous, workspaceMetas: previous.workspaceMetas.filter(wm => wm._id !== workspaceMeta._id) };
    }
    return previous;
  });
}

function addOrganizationDataWorkspaceMeta(queryClient: QueryClient, organizationId: string, workspaceMeta: BaseModel) {
  queryClient.setQueryData<OrganizationData>(organizationDataKeys.byOrganizationId(organizationId), previous => {
    if (previous) {
      return { ...previous, workspaceMetas: [...previous.workspaceMetas, workspaceMeta as WorkspaceMeta] };
    }
    return previous;
  });
}

function findWorkspaceIdForDoc(queryClient: QueryClient, doc: BaseModel): string | undefined {
  const cachedWorkspaces = queryClient.getQueriesData<WorkspaceChildren>({ queryKey: workspaceChildrenKeys.all });
  for (const [queryKey, data] of cachedWorkspaces) {
    const workspaceId = queryKey[1] as string;
    if (!data || !data.children || !('requestsAndGroups' in data.children)) {
      continue;
    }
    if (
      doc.parentId === workspaceId ||
      data.children.requestsAndGroups.some(r => r._id === doc._id || r._id === doc.parentId)
    ) {
      return workspaceId;
    }
  }
  return undefined;
}

function replaceById<T extends BaseModel>(list: T[], doc: BaseModel): T[] | null {
  const index = list.findIndex(item => item._id === doc._id);
  if (index === -1) {
    return null;
  }
  if (list[index].parentId !== doc.parentId) {
    return null;
  }
  const next = list.slice();
  next[index] = doc as unknown as T;
  return next;
}

function updateCollectionChildrenWithUpdatedDoc(
  collectionChildren: CollectionWorkspaceChildren,
  doc: BaseModel,
): CollectionWorkspaceChildren | null {
  if (COLLECTION_REQUEST_DOC_TYPES.includes(doc.type)) {
    const requestsAndGroups = replaceById(collectionChildren.children.requestsAndGroups, doc);
    return requestsAndGroups ? { ...collectionChildren, children: { requestsAndGroups } } : null;
  }
  if (COLLECTION_REQUEST_META_DOC_TYPES.includes(doc.type)) {
    const allRequestMetas = replaceById(collectionChildren.childrenMetas.allRequestMetas, doc);
    return allRequestMetas
      ? { ...collectionChildren, childrenMetas: { ...collectionChildren.childrenMetas, allRequestMetas } }
      : null;
  }
  if (doc.type === models.requestGroupMeta.type) {
    const requestGroupMetas = replaceById(collectionChildren.childrenMetas.requestGroupMetas, doc);
    return requestGroupMetas
      ? { ...collectionChildren, childrenMetas: { ...collectionChildren.childrenMetas, requestGroupMetas } }
      : null;
  }
  return null;
}

function invalidateCacheData(queryClient: QueryClient, changes: ChangeBufferEvent[]) {
  const organizationIdsToRevalidate = new Set<string>();
  const workspaceIdsToRevalidate: string[] = [];

  for (const [event, doc, patches] of changes) {
    if (!MONITOR_DOC_TYPES.includes(doc.type)) {
      continue;
    }

    if (doc.type === models.project.type) {
      organizationIdsToRevalidate.add(doc.parentId);
      continue;
    }

    if (doc.type === models.workspace.type) {
      const { organizationId } = findOrganizationAndProjectIdForWorkspace(queryClient, doc) || {};
      if (organizationId) {
        organizationIdsToRevalidate.add(organizationId);
      }
      continue;
    }

    if (doc.type === models.workspaceMeta.type) {
      // Meta changes very frequently, so patch the cache in place instead of invalidating it.
      const organizationId = findOrganizationFromWorkspaceId(queryClient, doc.parentId);
      if (organizationId) {
        if (event === 'insert') {
          addOrganizationDataWorkspaceMeta(queryClient, organizationId, doc);
        } else if (event === 'update') {
          updateOrganizationDataWorkspaceMeta(queryClient, organizationId, doc);
        } else if (event === 'remove') {
          deleteOrganizationDataWorkspaceMeta(queryClient, organizationId, doc);
        }
      }
      continue;
    }

    if (COLLECTION_CHILDREN_DOC_TYPES.includes(doc.type)) {
      if (event === 'update') {
        const isParentIdChange = patches.some(patch => 'parentId' in patch);
        if (!isParentIdChange) {
          const docWorkspaceId = findWorkspaceIdForDoc(queryClient, doc);
          if (docWorkspaceId) {
            queryClient.setQueryData<CollectionWorkspaceChildren>(
              workspaceChildrenKeys.byWorkspaceId(docWorkspaceId),
              previous => {
                if (previous) {
                  const updated = updateCollectionChildrenWithUpdatedDoc(previous, doc);
                  if (updated) {
                    return updated;
                  }
                }
                return previous;
              },
            );
          }
          continue;
        }
        const docId = doc._id;
        const docNewParentId = doc.parentId;
        let originDocWorkspaceId: string | undefined;
        let newDocWorkspaceId: string | undefined;

        for (const [queryKey, data] of queryClient.getQueriesData<WorkspaceChildren>({
          queryKey: workspaceChildrenKeys.all,
        })) {
          const workspaceId = queryKey[1] as string;
          if (docNewParentId === workspaceId) {
            newDocWorkspaceId = workspaceId;
          }
          if (!data || !data.children || !('requestsAndGroups' in data.children)) {
            continue;
          }
          if (data.children.requestsAndGroups.some(r => r._id === docId)) {
            originDocWorkspaceId = workspaceId;
          }
          if (data.children.requestsAndGroups.some(r => r._id === docNewParentId)) {
            newDocWorkspaceId = workspaceId;
          }
        }
        if (originDocWorkspaceId) {
          workspaceIdsToRevalidate.push(originDocWorkspaceId);
        }
        if (newDocWorkspaceId && newDocWorkspaceId !== originDocWorkspaceId) {
          workspaceIdsToRevalidate.push(newDocWorkspaceId);
        }
      } else {
        // add or remove requests, refresh the collection children
        const docWorkspaceId = findWorkspaceIdForDoc(queryClient, doc);
        docWorkspaceId && workspaceIdsToRevalidate.push(docWorkspaceId);
      }
    } else {
      // Other workspace child types (mock servers, api specs, mcp requests, environments), invalidate and refetch the workspace children
      const parentId = doc.parentId;
      if (models.workspace.isWorkspaceId(parentId)) {
        workspaceIdsToRevalidate.push(parentId);
      }
    }
  }

  // Must use refreshType: 'all' to trigger observers
  workspaceIdsToRevalidate.forEach(workspaceId =>
    queryClient.invalidateQueries({ queryKey: workspaceChildrenKeys.byWorkspaceId(workspaceId), refetchType: 'all' }),
  );
  organizationIdsToRevalidate.forEach(organizationId =>
    queryClient.invalidateQueries({
      queryKey: organizationDataKeys.byOrganizationId(organizationId),
      refetchType: 'all',
    }),
  );
}

export type AppDataCacheUpdateListener = (queryKey: readonly unknown[], data: unknown) => void;

// Create app data cache service which will listen to database changes and update the cache accordingly
export function createCachedAppDataService(
  appData: AppDataService,
  db: IDatabase,
  onUpdate?: AppDataCacheUpdateListener,
): AppDataService {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        gcTime: Infinity,
        retry: false,
      },
    },
  });

  if (onUpdate) {
    queryClient.getQueryCache().subscribe(event => {
      if (event.type === 'updated' && event.action.type === 'success' && event.query.state.data !== undefined) {
        onUpdate(event.query.queryKey, event.query.state.data);
      }
    });
  }

  const pendingWorkspaceChildrenFetches = new Map<
    string,
    { ids: Set<string>; promise: Promise<Map<string, WorkspaceChildren>> }
  >();

  // Combine every workspaceId requested within the same microtask, for a given scope, into a
  // single underlying DB sweep — mirrors the batching that used to live in the renderer hook.
  const loadUncachedWorkspaceChildren = (
    workspaceIds: string[],
    scope: WorkspaceScope | undefined,
  ): Promise<Map<string, WorkspaceChildren>> => {
    const scopeKey = scope || '__all__';
    let pending = pendingWorkspaceChildrenFetches.get(scopeKey);
    if (!pending) {
      const ids = new Set<string>();
      const promise = Promise.resolve().then(() => {
        pendingWorkspaceChildrenFetches.delete(scopeKey);
        return appData.getWorkspaceChildren([...ids], scope);
      });
      pending = { ids, promise };
      pendingWorkspaceChildrenFetches.set(scopeKey, pending);
    }
    workspaceIds.forEach(id => pending!.ids.add(id));
    return pending.promise;
  };

  const getOrganizationData = (organizationId: string): Promise<OrganizationData> =>
    queryClient.fetchQuery({
      queryKey: organizationDataKeys.byOrganizationId(organizationId),
      queryFn: () => appData.getOrganizationData(organizationId),
    });

  const getWorkspaceChildren = async <S extends WorkspaceScope | undefined = undefined>(
    workspaceIds: string[],
    scope?: S,
  ): Promise<Map<string, WorkspaceChildrenForScope<S>>> => {
    const result = new Map<string, WorkspaceChildrenForScope<S>>();
    await Promise.all(
      workspaceIds.map(async workspaceId => {
        const data = await queryClient.fetchQuery({
          queryKey: workspaceChildrenKeys.byWorkspaceId(workspaceId),
          queryFn: async () => {
            const fetched = await loadUncachedWorkspaceChildren([workspaceId], scope);
            return fetched.get(workspaceId);
          },
        });
        if (data) {
          result.set(workspaceId, data as WorkspaceChildrenForScope<S>);
        }
      }),
    );
    return result;
  };

  // Register a listener to invalidate the cache when the database changes.
  db.onChange(changes => invalidateCacheData(queryClient, changes));

  return {
    ...appData,
    getOrganizationData,
    getWorkspaceChildren,
  };
}
