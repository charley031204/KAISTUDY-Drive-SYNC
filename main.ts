import { App, Plugin, PluginSettingTab, Setting, Notice, requestUrl, TFile, TFolder, moment, TAbstractFile } from 'obsidian';
import * as http from 'http';
import { randomBytes, createHash } from 'crypto';

// --- CONFIGURATION ---
const CLIENT_ID = '234880468147-ra36kvpnhqrnrrqjkp9uvk5ko18tfl28.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const APP_FOLDER_NAME = 'ObsidianGoogleSyncApp';
const LOG_FILE_NAME = '.googlesync-log.json';
// --------------------

const REDIRECT_URI = 'http://127.0.0.1:42813/callback';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API_URL = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3';
const SCOPES = ['https://www.googleapis.com/auth/drive'];

// --- TYPE DEFINITIONS ---

interface LoggedItem {
    syncId: string;
    gdriveId: string;
    path: string;
    mtime: number;
    sha256?: string; // Only for files
    isFolder: boolean;
}

interface MasterLog {
    items: { [syncId: string]: LoggedItem };
    deleted: { [syncId: string]: number };
}

interface GoogleDriveSyncSettings {
    refreshToken: string | null;
    userEmail: string | null;
    automaticSync: boolean;
    syncInterval: number;
    localShadow: MasterLog;
}

const DEFAULT_SETTINGS: GoogleDriveSyncSettings = {
    refreshToken: null,
    userEmail: null,
    automaticSync: false,
    syncInterval: 10,
    localShadow: { items: {}, deleted: {} },
}

type LocalStateItem = {
    path: string;
    mtime: number;
    sha256?: string;
    item: TAbstractFile;
    isFolder: boolean;
};

type RemoteStateItem = {
    gdriveId: string;
    name: string;
    path: string;
    mtime: number;
    parentId: string;
    isFolder: boolean;
};

type SyncAction =
    | { type: 'UPLOAD_NEW_FILE'; local: LocalStateItem }
    | { type: 'CREATE_REMOTE_FOLDER'; local: LocalStateItem }
    | { type: 'UPDATE_REMOTE_FILE'; local: LocalStateItem; remote: LoggedItem }
    | { type: 'RESTORE_REMOTE_FILE'; local: LocalStateItem; log: LoggedItem }
    | { type: 'DOWNLOAD_NEW_FILE'; remote: RemoteStateItem; log?: LoggedItem }
    | { type: 'CREATE_LOCAL_FOLDER'; remote: RemoteStateItem; log?: LoggedItem }
    | { type: 'UPDATE_LOCAL_FILE'; remote: RemoteStateItem; log: LoggedItem }
    | { type: 'DELETE_REMOTE'; log: LoggedItem }
    | { type: 'DELETE_LOCAL'; log: LoggedItem }
    | { type: 'RENAME_REMOTE'; local: LocalStateItem; log: LoggedItem }
    | { type: 'MOVE_REMOTE'; local: LocalStateItem; log: LoggedItem }
    | { type: 'RENAME_LOCAL'; remote: RemoteStateItem; log: LoggedItem }
    | { type: 'MOVE_LOCAL'; remote: RemoteStateItem; log: LoggedItem }
    | { type: 'HANDLE_CONFLICT'; local: LocalStateItem; remote: RemoteStateItem; log: LoggedItem };

// --- HELPER FUNCTIONS ---

function generateSyncId(): string {
    return randomBytes(16).toString('hex');
}

async function calculateSha256(arrayBuffer: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function escapeQuery(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// --- MAIN PLUGIN CLASS ---

export default class GoogleDriveSyncPlugin extends Plugin {
    settings: GoogleDriveSyncSettings;
    private server: http.Server | null = null;
    private authState: string | null = null;
    private authCodeVerifier: string | null = null;
    private isAuthenticating: boolean = false;
    private isSyncing: boolean = false;
    private autoSyncIntervalId: number | null = null;

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new GoogleDriveSyncSettingTab(this.app, this));
        this.addRibbonIcon('sync', 'Sync with Google Drive', () => this.syncVault());
        this.toggleAutoSync();
    }

    onunload() {
        this.stopCallbackServer();
        if (this.autoSyncIntervalId) {
            window.clearInterval(this.autoSyncIntervalId);
        }
    }

    toggleAutoSync() {
        if (this.autoSyncIntervalId) {
            window.clearInterval(this.autoSyncIntervalId);
            this.autoSyncIntervalId = null;
        }
        if (this.settings.automaticSync && this.settings.syncInterval > 0 && this.settings.refreshToken) {
            this.autoSyncIntervalId = window.setInterval(
                () => this.syncVault(true),
                this.settings.syncInterval * 60 * 1000
            );
            this.registerInterval(this.autoSyncIntervalId);
            console.log(`Google Drive Sync: Auto-sync enabled. Interval: ${this.settings.syncInterval} minutes.`);
        } else {
            console.log('Google Drive Sync: Auto-sync disabled.');
        }
    }

    async syncVault(isAutoSync = false) {
        if (this.isSyncing) {
            if (!isAutoSync) new Notice('Sync is already in progress.');
            return;
        }
        if (!this.settings.refreshToken) {
            if (!isAutoSync) new Notice('Please connect to Google Drive first.');
            return;
        }

        this.isSyncing = true;
        const statusNotice = new Notice('Starting sync...', 0);

        try {
            statusNotice.setMessage('1/5: Preparing for sync...');
            const accessToken = await this.getAccessToken();
            if (!accessToken) throw new Error("Authentication failed.");

            const { vaultFolderId } = await this.getDriveFolderIds(accessToken);

            const [localState, remoteState, masterLog] = await Promise.all([
                this.loadLocalState(),
                this.loadRemoteState(accessToken, vaultFolderId),
                this.loadMasterLog(accessToken, vaultFolderId)
            ]);
            
            let localShadow = this.settings.localShadow;
            if (!localShadow || typeof localShadow !== 'object') {
                localShadow = { items: {}, deleted: {} };
            }
            localShadow.items = localShadow.items || {};
            localShadow.deleted = localShadow.deleted || {};
            
            const isShadowEmpty = Object.keys(localShadow.items).length === 0 && Object.keys(localShadow.deleted).length === 0;
            const isMasterLogEmpty = Object.keys(masterLog.items).length === 0 && Object.keys(masterLog.deleted).length === 0;
            const isForcedRemerge = !isShadowEmpty && isMasterLogEmpty;
            
            let actions: SyncAction[];
            let initialMasterLog: MasterLog = { items: {}, deleted: {} };
            const isInitialSyncFlow = isShadowEmpty || isForcedRemerge;

            if (isInitialSyncFlow) {
                if (isForcedRemerge) {
                    new Notice("Remote log is missing. Forcing a re-merge.");
                    statusNotice.setMessage('Remote log missing. Re-merging local and remote states...');
                } else {
                    statusNotice.setMessage('First sync detected. Merging local and remote states...');
                }
                const result = this.planFirstSyncMerge(localState, remoteState);
                actions = result.actions;
                initialMasterLog = result.masterLog;
            } else {
                statusNotice.setMessage('2/5: Analyzing changes...');
                actions = this.planActions(localState, remoteState, masterLog, localShadow);
            }

            if (actions.length === 0) {
                if (isInitialSyncFlow) {
                    await this.uploadMasterLog(accessToken, vaultFolderId, initialMasterLog);
                    this.settings.localShadow = JSON.parse(JSON.stringify(initialMasterLog));
                    await this.saveSettings();
                }
                statusNotice.setMessage('Everything is up to date!');
                setTimeout(() => statusNotice.hide(), 3000);
                this.isSyncing = false;
                return;
            }
            
            statusNotice.setMessage(`3/5: Executing ${actions.length} actions...`);
            const newMasterLog = await this.executeActions(accessToken, vaultFolderId, actions, isInitialSyncFlow ? initialMasterLog : masterLog, statusNotice);

            statusNotice.setMessage('4/5: Finalizing sync...');
            await this.uploadMasterLog(accessToken, vaultFolderId, newMasterLog);
            this.settings.localShadow = JSON.parse(JSON.stringify(newMasterLog));
            await this.saveSettings();

            statusNotice.setMessage('5/5: Sync complete!');
            setTimeout(() => statusNotice.hide(), 5000);

        } catch (error) {
            const errorMessage = 'Sync failed. Check console for details.';
            console.error("Google Drive Sync Error:", error);
            statusNotice.setMessage(errorMessage);
            setTimeout(() => statusNotice.hide(), 10000);
        } finally {
            this.isSyncing = false;
        }
    }

    async loadLocalState(): Promise<Map<string, LocalStateItem>> {
        const localState = new Map<string, LocalStateItem>();
        const excludedFolders = ['.obsidian/', '.trash/'];
    
        const allFiles = this.app.vault.getAllLoadedFiles();
    
        for (const item of allFiles) {
            if (excludedFolders.some(folder => item.path.startsWith(folder))) continue;
    
            if (item instanceof TFile) {
                const content = await this.app.vault.readBinary(item);
                const sha256 = await calculateSha256(content);
                localState.set(item.path, {
                    path: item.path,
                    mtime: item.stat.mtime,
                    sha256: sha256,
                    item: item,
                    isFolder: false,
                });
            } else if (item instanceof TFolder) {
                localState.set(item.path, {
                    path: item.path,
                    mtime: 0, 
                    item: item,
                    isFolder: true,
                });
            }
        }
        return localState;
    }

    async loadRemoteState(accessToken: string, vaultFolderId: string): Promise<Map<string, RemoteStateItem>> {
        const remoteState = new Map<string, RemoteStateItem>();
        const folders = new Map<string, {name: string, parentId: string, isVaultRoot: boolean}>();
        folders.set(vaultFolderId, {name: '', parentId: '', isVaultRoot: true});

        const allGdriveFiles = await this.listAllFilesRecursive(accessToken, vaultFolderId);
        
        for (const file of allGdriveFiles) {
            if(file.mimeType === 'application/vnd.google-apps.folder' && file.parents && file.parents.length > 0) {
                folders.set(file.id, { name: file.name, parentId: file.parents[0], isVaultRoot: false });
            }
        }

        const buildPath = (gdriveId: string): string | null => {
            const item = folders.get(gdriveId);
            if (!item) return null;
            if (item.isVaultRoot) return ''; 
        
            let path = item.name;
            let currentParentId = item.parentId;
            while(currentParentId) {
                const parentFolder = folders.get(currentParentId);
                if (!parentFolder) return null; 
                if (parentFolder.isVaultRoot) break;
                path = `${parentFolder.name}/${path}`;
                currentParentId = parentFolder.parentId;
            }
            return path;
        }

        for (const file of allGdriveFiles) {
             if (file.name === LOG_FILE_NAME) continue;
             const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
             const parentId = file.parents?.[0];
             if (!parentId) continue;

             let path: string | null;
             if(isFolder) {
                path = buildPath(file.id);
             } else {
                const parentPath = buildPath(parentId);
                if (parentPath === null) continue;
                path = parentPath ? `${parentPath}/${file.name}` : file.name;
             }

             if (path === null) continue;

             remoteState.set(path, {
                gdriveId: file.id,
                name: file.name,
                path: path,
                mtime: new Date(file.modifiedTime).getTime(),
                parentId: parentId,
                isFolder: isFolder
            });
        }

        return remoteState;
    }
    
    async listAllFilesRecursive(accessToken: string, folderId: string): Promise<any[]> {
        const allFiles: any[] = [];
        const foldersToProcess = [folderId];
        const processedFolders = new Set<string>();

        while (foldersToProcess.length > 0) {
            const currentFolderId = foldersToProcess.shift()!;
            if (processedFolders.has(currentFolderId)) continue;
            processedFolders.add(currentFolderId);

            let pageToken: string | undefined = undefined;
            do {
                const searchUrl = new URL(`${DRIVE_API_URL}/files`);
                const query = `'${currentFolderId}' in parents and trashed=false`;
                searchUrl.searchParams.append('q', query);
                searchUrl.searchParams.append('fields', 'nextPageToken, files(id, name, mimeType, modifiedTime, parents)');
                searchUrl.searchParams.append('pageSize', '1000');
                if (pageToken) searchUrl.searchParams.append('pageToken', pageToken);

                const response = await requestUrl({ method: 'GET', url: searchUrl.toString(), headers: { 'Authorization': `Bearer ${accessToken}` } });
                const data = response.json;

                if (data.files) {
                    for (const file of data.files) {
                        allFiles.push(file);
                        if (file.mimeType === 'application/vnd.google-apps.folder') {
                            foldersToProcess.push(file.id);
                        }
                    }
                }
                pageToken = data.nextPageToken;
            } while (pageToken);
        }
        return allFiles;
    }


    async loadMasterLog(accessToken: string, targetFolderId: string): Promise<MasterLog> {
        const logFileId = await this.getFileIdByName(accessToken, LOG_FILE_NAME, targetFolderId);
        if (!logFileId) {
            return { items: {}, deleted: {} };
        }
        try {
            const response = await requestUrl({
                url: `${DRIVE_API_URL}/files/${logFileId}?alt=media`,
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            return response.json;
        } catch (e) {
            console.error("Could not parse Master Log, starting fresh.", e);
            return { items: {}, deleted: {} };
        }
    }

    planFirstSyncMerge(localState: Map<string, LocalStateItem>, remoteState: Map<string, RemoteStateItem>): { actions: SyncAction[], masterLog: MasterLog } {
        const actions: SyncAction[] = [];
        const masterLog: MasterLog = { items: {}, deleted: {} };
        const processedRemotePaths = new Set<string>();

        for (const [path, localItem] of localState.entries()) {
            const remoteItem = remoteState.get(path);
            if (remoteItem && localItem.isFolder === remoteItem.isFolder) {
                const syncId = generateSyncId();
                masterLog.items[syncId] = {
                    syncId,
                    gdriveId: remoteItem.gdriveId,
                    path: localItem.path,
                    mtime: localItem.mtime,
                    sha256: localItem.sha256,
                    isFolder: localItem.isFolder
                };
                processedRemotePaths.add(path);
                
                if (!localItem.isFolder && localItem.mtime > remoteItem.mtime) {
                    actions.push({ type: 'UPDATE_REMOTE_FILE', local: localItem, remote: masterLog.items[syncId] });
                }
            } else {
                if(localItem.isFolder) {
                    actions.push({ type: 'CREATE_REMOTE_FOLDER', local: localItem });
                } else {
                    actions.push({ type: 'UPLOAD_NEW_FILE', local: localItem });
                }
            }
        }

        for (const [path, remoteItem] of remoteState.entries()) {
            if (!processedRemotePaths.has(path)) {
                if(remoteItem.isFolder) {
                    actions.push({ type: 'CREATE_LOCAL_FOLDER', remote: remoteItem });
                } else {
                    actions.push({ type: 'DOWNLOAD_NEW_FILE', remote: remoteItem });
                }
            }
        }

        return { actions, masterLog };
    }

    planActions(
        localState: Map<string, LocalStateItem>,
        remoteState: Map<string, RemoteStateItem>,
        masterLog: MasterLog,
        localShadow: MasterLog
    ): SyncAction[] {
        const actions: SyncAction[] = [];
        const localBySyncId = new Map<string, LocalStateItem>();
        const shadowBySyncId = new Map(Object.entries(localShadow.items));
        const trackedLocalPaths = new Set<string>();
        const shadowByPath = new Map(Object.values(localShadow.items).map(item => [item.path, item]));

        const unmatchedShadowItems = new Map(shadowBySyncId);
        const unmatchedLocalItems = new Map(localState);

        // Pass 1: Find stable items
        for (const [syncId, sItem] of shadowBySyncId.entries()) {
            const lItem = localState.get(sItem.path);
            if (lItem && lItem.isFolder === sItem.isFolder) {
                localBySyncId.set(syncId, lItem);
                unmatchedShadowItems.delete(syncId);
                unmatchedLocalItems.delete(lItem.path);
            }
        }

        // Pass 2: Find moved/renamed items by heuristics
        for (const [syncId, sItem] of unmatchedShadowItems.entries()) {
            let bestMatch: { lItem: LocalStateItem; score: number } | null = null;
            for (const lItem of unmatchedLocalItems.values()) {
                if (sItem.isFolder !== lItem.isFolder) continue;

                let score = 0;
                const sParent = sItem.path.includes('/') ? sItem.path.substring(0, sItem.path.lastIndexOf('/')) : '';
                const lParent = lItem.item.parent ? lItem.item.parent.path : '';
                const sName = sItem.path.substring(sItem.path.lastIndexOf('/') + 1);
                const lName = lItem.item.name;

                if (sName === lName) score += 2; // Strong indicator of a move
                if (sParent === lParent) score += 1; // Strong indicator of a rename

                if (score > (bestMatch?.score ?? 0)) {
                    bestMatch = { lItem, score };
                }
            }

            if (bestMatch && bestMatch.score > 0) {
                localBySyncId.set(syncId, bestMatch.lItem);
                unmatchedShadowItems.delete(syncId);
                unmatchedLocalItems.delete(bestMatch.lItem.path);
            }
        }

        // Pass 3: Plan actions for matched items
        for(const [syncId, lItem] of localBySyncId.entries()) {
            const sItem = shadowBySyncId.get(syncId)!;
            trackedLocalPaths.add(lItem.path);
            
            if (lItem.path !== sItem.path) {
                const lItemParentPath = lItem.item.parent ? lItem.item.parent.path : '';
                const sItemParentPath = sItem.path.includes('/') ? sItem.path.substring(0, sItem.path.lastIndexOf('/')) : '';
                actions.push({ type: lItemParentPath === sItemParentPath ? 'RENAME_REMOTE' : 'MOVE_REMOTE', local: lItem, log: sItem });
            }
            if(!lItem.isFolder && lItem.sha256 !== sItem.sha256) {
                const mItem = masterLog.items[syncId];
                if(mItem && mItem.sha256 !== sItem.sha256) {
                    const remote = remoteState.get(mItem.path);
                    if(remote) actions.push({ type: 'HANDLE_CONFLICT', local: lItem, remote: remote, log: mItem});
                } else {
                     actions.push({ type: 'UPDATE_REMOTE_FILE', local: lItem, remote: sItem});
                }
            }
        }

        // Pass 4: Plan actions for remote changes and deletions
        for(const [syncId, mItem] of Object.entries(masterLog.items)) {
            const sItem = shadowBySyncId.get(syncId);
            const rItem = remoteState.get(mItem.path);

            if (!rItem) {
                if (sItem && localState.has(sItem.path)) {
                    const localToRestore = localState.get(sItem.path)!;
                    if(!localToRestore.isFolder) actions.push({ type: 'RESTORE_REMOTE_FILE', local: localToRestore, log: mItem });
                }
                else if (sItem) {
                     actions.push({ type: 'DELETE_LOCAL', log: sItem });
                }
                continue; 
            }

            if(!sItem) {
                if(rItem.isFolder) actions.push({ type: 'CREATE_LOCAL_FOLDER', remote: rItem, log: mItem });
                else actions.push({ type: 'DOWNLOAD_NEW_FILE', remote: rItem, log: mItem });
                continue;
            }

            if(mItem.path !== sItem.path && !actions.some(a => (a.type === 'RENAME_REMOTE' || a.type === 'MOVE_REMOTE') && a.log.syncId === syncId)) {
                const isRename = rItem.name !== sItem.path.split('/').pop();
                if(isRename) actions.push({ type: 'RENAME_LOCAL', remote: rItem, log: mItem });
                else actions.push({ type: 'MOVE_LOCAL', remote: rItem, log: mItem });
            }
            
            if(!mItem.isFolder && mItem.sha256 !== sItem.sha256 && !actions.some(a => {
                if (a.type === 'UPDATE_REMOTE_FILE' && a.remote.syncId === syncId) return true;
                if (a.type === 'RESTORE_REMOTE_FILE' && a.log.syncId === syncId) return true;
                if (a.type === 'HANDLE_CONFLICT' && a.log.syncId === syncId) return true;
                return false;
            })) {
                 actions.push({ type: 'UPDATE_LOCAL_FILE', remote: rItem, log: mItem });
            }
        }
        
        for (const [syncId, deletionTime] of Object.entries(masterLog.deleted)) {
            if (shadowBySyncId.has(syncId) && deletionTime > (localShadow.deleted[syncId] || 0)) {
                actions.push({ type: 'DELETE_LOCAL', log: shadowBySyncId.get(syncId)! });
            }
        }
        
        // Pass 5: Plan for remaining unmatched items
        for (const sItem of unmatchedShadowItems.values()) {
            actions.push({ type: 'DELETE_REMOTE', log: sItem });
        }
        for (const lItem of unmatchedLocalItems.values()) {
            if (lItem.isFolder) actions.push({ type: 'CREATE_REMOTE_FOLDER', local: lItem });
            else actions.push({ type: 'UPLOAD_NEW_FILE', local: lItem });
        }
        
        const uniqueActions = new Map<string, SyncAction>();
        for (const action of actions) {
            const key = `${action.type}-${this.getActionPath(action)}`;
            uniqueActions.set(key, action);
        }
        return Array.from(uniqueActions.values());
    }

    private getActionPath(action: SyncAction): string {
        switch(action.type) {
            case 'UPLOAD_NEW_FILE': case 'CREATE_REMOTE_FOLDER': case 'UPDATE_REMOTE_FILE':
            case 'RESTORE_REMOTE_FILE': case 'RENAME_REMOTE': case 'MOVE_REMOTE': case 'HANDLE_CONFLICT':
                return action.local.path;
            case 'DOWNLOAD_NEW_FILE': case 'CREATE_LOCAL_FOLDER': case 'UPDATE_LOCAL_FILE':
            case 'RENAME_LOCAL': case 'MOVE_LOCAL':
                return action.remote.path;
            case 'DELETE_REMOTE': case 'DELETE_LOCAL':
                return action.log.path;
        }
    }

    async executeActions(
        accessToken: string,
        vaultFolderId: string,
        actions: SyncAction[],
        currentLog: MasterLog,
        statusNotice: Notice
    ): Promise<MasterLog> {
        const newLog: MasterLog = JSON.parse(JSON.stringify(currentLog));
        let completedCount = 0;

        const actionPriority: { [key in SyncAction['type']]: number } = {
            'CREATE_REMOTE_FOLDER': 1, 'CREATE_LOCAL_FOLDER': 1,
            'RENAME_REMOTE': 2, 'MOVE_REMOTE': 2, 'RENAME_LOCAL': 2, 'MOVE_LOCAL': 2,
            'UPLOAD_NEW_FILE': 3, 'DOWNLOAD_NEW_FILE': 3, 'RESTORE_REMOTE_FILE': 3,
            'UPDATE_REMOTE_FILE': 4, 'UPDATE_LOCAL_FILE': 4,
            'HANDLE_CONFLICT': 5,
            'DELETE_REMOTE': 6, 'DELETE_LOCAL': 6,
        };
    
        const sortedActions = actions.sort((a, b) => {
            const priorityA = actionPriority[a.type];
            const priorityB = actionPriority[b.type];
            if (priorityA !== priorityB) return priorityA - priorityB;
            
            if ((a.type === 'DELETE_REMOTE' || a.type === 'DELETE_LOCAL') && (b.type === 'DELETE_REMOTE' || b.type === 'DELETE_LOCAL')) {
                const aIsFolder = a.log.isFolder;
                const bIsFolder = b.log.isFolder;
                if (aIsFolder && !bIsFolder) return 1; 
                if (!aIsFolder && bIsFolder) return -1;
            }
            return 0;
        });

        const updateNotice = (msg: string) => {
            completedCount++;
            statusNotice.setMessage(`3/5: Executing actions (${completedCount}/${sortedActions.length})\n${msg}`);
        };
        
        for (const action of sortedActions) {
            updateNotice(`${action.type}: ${this.getActionPath(action)}`);
            try {
                switch (action.type) {
                    case 'CREATE_LOCAL_FOLDER':
                        await this.app.vault.createFolder(action.remote.path);
                        if (action.log) {
                            newLog.items[action.log.syncId] = action.log;
                        }
                        break;
                    case 'DOWNLOAD_NEW_FILE':
                    case 'UPDATE_LOCAL_FILE':
                        await this.downloadFile(accessToken, action.remote.gdriveId, action.remote.path);
                        if (action.log) {
                            newLog.items[action.log.syncId] = action.log;
                        }
                        break;
                    case 'RENAME_LOCAL':
                    case 'MOVE_LOCAL':
                        const itemToMove = this.app.vault.getAbstractFileByPath(action.log.path);
                        if (itemToMove) await this.app.vault.rename(itemToMove, action.remote.path);
                        newLog.items[action.log.syncId].path = action.remote.path;
                        break;
                    case 'DELETE_LOCAL':
                        const itemToDelete = this.app.vault.getAbstractFileByPath(action.log.path);
                        if (itemToDelete) await this.app.vault.delete(itemToDelete, true);
                        delete newLog.items[action.log.syncId];
                        newLog.deleted[action.log.syncId] = Date.now();
                        break;
                    case 'CREATE_REMOTE_FOLDER': {
                        const { gdriveId } = await this.createRemoteFolder(accessToken, vaultFolderId, action.local.path);
                        const syncId = generateSyncId();
                        newLog.items[syncId] = { syncId, gdriveId, path: action.local.path, mtime: action.local.mtime, isFolder: true };
                        break;
                    }
                    case 'UPLOAD_NEW_FILE': {
                        const { gdriveId } = await this.uploadFile(accessToken, vaultFolderId, action.local.item as TFile);
                        const syncId = generateSyncId();
                        newLog.items[syncId] = { syncId, gdriveId, path: action.local.path, mtime: action.local.mtime, sha256: action.local.sha256, isFolder: false };
                        break;
                    }
                    case 'UPDATE_REMOTE_FILE': {
                        await this.updateRemoteFileContent(accessToken, action.remote.gdriveId, action.local.item as TFile);
                        newLog.items[action.remote.syncId] = { ...newLog.items[action.remote.syncId], mtime: action.local.mtime, sha256: action.local.sha256 };
                        break;
                    }
                    case 'RESTORE_REMOTE_FILE': {
                        console.log(`Restoring remotely deleted file: ${action.local.path}`);
                        const { gdriveId } = await this.uploadFile(accessToken, vaultFolderId, action.local.item as TFile);
                        newLog.items[action.log.syncId].gdriveId = gdriveId;
                        newLog.items[action.log.syncId].mtime = action.local.mtime;
                        newLog.items[action.log.syncId].sha256 = action.local.sha256;
                        break;
                    }
                    case 'RENAME_REMOTE': {
                        await this.renameRemoteItem(accessToken, action.log.gdriveId, action.local.item.name);
                        const oldPath = action.log.path;
                        const newPath = action.local.path;
                        newLog.items[action.log.syncId].path = newPath;
                        newLog.items[action.log.syncId].mtime = action.local.mtime;
                        for (const childId in newLog.items) {
                            if (newLog.items[childId].path.startsWith(oldPath + '/')) {
                                newLog.items[childId].path = newLog.items[childId].path.replace(oldPath, newPath);
                            }
                        }
                        break;
                    }
                    case 'MOVE_REMOTE': {
                        const newParentId = await this.resolvePathToGdriveId(accessToken, vaultFolderId, action.local.item.parent!.path);
                        const parents = await this.getParents(accessToken, action.log.gdriveId);
                        await this.moveRemoteItem(accessToken, action.log.gdriveId, parents[0], newParentId);
                        const oldPath = action.log.path;
                        const newPath = action.local.path;
                        newLog.items[action.log.syncId].path = newPath;
                        newLog.items[action.log.syncId].mtime = action.local.mtime;
                        for (const childId in newLog.items) {
                            if (newLog.items[childId].path.startsWith(oldPath + '/')) {
                                newLog.items[childId].path = newLog.items[childId].path.replace(oldPath, newPath);
                            }
                        }
                        break;
                    }
                    case 'DELETE_REMOTE':
                        await this.deleteRemoteItem(accessToken, action.log.gdriveId);
                        delete newLog.items[action.log.syncId];
                        newLog.deleted[action.log.syncId] = Date.now();
                        break;
                     case 'HANDLE_CONFLICT': {
                        const parentPath = (action.local.item as TFile).parent?.path ?? '';
                        const newPath = `${parentPath ? parentPath + '/' : ''}${action.local.item.name} (Conflicted Copy ${moment().format('YYYY-MM-DD HH-mm-ss')}).md`;
                        
                        await this.app.vault.rename(action.local.item, newPath);
                        const conflictingFile = this.app.vault.getAbstractFileByPath(newPath) as TFile;
                        const content = await this.app.vault.readBinary(conflictingFile);
                        const sha256 = await calculateSha256(content);

                        await this.downloadFile(accessToken, action.remote.gdriveId, action.remote.path);
                        if (newLog.items[action.log.syncId]) {
                            const remoteMeta = await this.getMetadata(accessToken, action.remote.gdriveId, "md5Checksum");
                            if (remoteMeta && remoteMeta.md5Checksum) {
                                newLog.items[action.log.syncId].sha256 = remoteMeta.md5Checksum;
                            }
                        }

                        const { gdriveId } = await this.uploadFile(accessToken, vaultFolderId, conflictingFile);
                        const syncId = generateSyncId();
                        newLog.items[syncId] = { syncId, gdriveId, path: newPath, mtime: conflictingFile.stat.mtime, sha256, isFolder: false };
                        new Notice(`Conflict for ${action.log.path}. Local version renamed, remote downloaded.`);
                        break;
                    }
                }
            } catch(e) { console.error(`Failed to execute ${action.type} for ${this.getActionPath(action)}`, e); }
        }

        return newLog;
    }

    private async getDriveFolderIds(accessToken: string): Promise<{ appFolderId: string, vaultFolderId: string }> {
        const appFolderId = await this.getOrCreateFolder(accessToken, APP_FOLDER_NAME, 'root');
        const vaultName = this.app.vault.getName();
        const vaultFolderId = await this.getOrCreateFolder(accessToken, vaultName, appFolderId);
        return { appFolderId, vaultFolderId };
    }
    
    async createRemoteFolder(accessToken: string, vaultFolderId: string, path: string): Promise<{gdriveId: string}> {
        const parentPath = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
        const folderName = path.substring(path.lastIndexOf('/') + 1);
        const parentId = await this.resolvePathToGdriveId(accessToken, vaultFolderId, parentPath);
        const gdriveId = await this.getOrCreateFolder(accessToken, folderName, parentId);
        return { gdriveId };
    }

    async uploadFile(accessToken: string, vaultFolderId: string, file: TFile): Promise<{ gdriveId: string, parentId: string }> {
        const parentPath = file.parent ? file.parent.path : '';
        const parentId = await this.resolvePathToGdriveId(accessToken, vaultFolderId, parentPath);
        
        const metadata = { name: file.name, parents: [parentId] };
        const fileContent = await this.app.vault.readBinary(file);
        
        const boundary = '-----' + Math.random().toString(36).substring(2);
        const requestBody = new Blob([
            `--${boundary}\r\n`,
            'Content-Type: application/json; charset=UTF-8\r\n\r\n',
            JSON.stringify(metadata),
            `\r\n--${boundary}\r\n`,
            'Content-Type: application/octet-stream\r\n\r\n',
            new Blob([fileContent]),
            `\r\n--${boundary}--`
        ]);

        const response = await requestUrl({
            method: 'POST',
            url: `${DRIVE_UPLOAD_URL}/files?uploadType=multipart`,
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
            body: await requestBody.arrayBuffer(),
        });
        return { gdriveId: response.json.id, parentId: parentId };
    }
    
    async downloadFile(accessToken: string, fileId: string, localPath: string) {
        const file = this.app.vault.getAbstractFileByPath(localPath);
        if (file instanceof TFolder) {
            await this.app.vault.delete(file, true);
        }
        const parentDir = localPath.includes('/') ? localPath.substring(0, localPath.lastIndexOf('/')) : '';
        if (parentDir && !this.app.vault.getAbstractFileByPath(parentDir)) {
            await this.app.vault.createFolder(parentDir);
        }

        const response = await requestUrl({
            url: `${DRIVE_API_URL}/files/${fileId}?alt=media`,
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (file instanceof TFile) {
            await this.app.vault.modifyBinary(file, response.arrayBuffer);
        } else {
            await this.app.vault.createBinary(localPath, response.arrayBuffer);
        }
    }
    
    async updateRemoteFileContent(accessToken: string, fileId: string, localFile: TFile) {
        const content = await this.app.vault.readBinary(localFile);
        await requestUrl({
            method: 'PATCH',
            url: `${DRIVE_UPLOAD_URL}/files/${fileId}?uploadType=media`,
            headers: { 'Authorization': `Bearer ${accessToken}` },
            body: content
        });
    }
    
    async renameRemoteItem(accessToken: string, itemId: string, newName: string) {
        await requestUrl({
            method: 'PATCH',
            url: `${DRIVE_API_URL}/files/${itemId}`,
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
        });
    }

    async moveRemoteItem(accessToken: string, itemId: string, oldParentId: string, newParentId: string) {
        const url = new URL(`${DRIVE_API_URL}/files/${itemId}`);
        if(oldParentId) url.searchParams.append('removeParents', oldParentId);
        url.searchParams.append('addParents', newParentId);

        await requestUrl({
            method: 'PATCH',
            url: url.toString(),
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
    }
    
    async deleteRemoteItem(accessToken: string, itemId: string) {
        try {
            await requestUrl({
                method: 'DELETE',
                url: `${DRIVE_API_URL}/files/${itemId}`,
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
        } catch (error) {
            if ((error as any).status !== 404) throw error;
        }
    }

    async uploadMasterLog(accessToken: string, targetFolderId: string, log: MasterLog) {
        const logContent = JSON.stringify(log, null, 2);
        let logFileId = await this.getFileIdByName(accessToken, LOG_FILE_NAME, targetFolderId);
        
        if (logFileId) {
            await requestUrl({
                method: 'PATCH',
                url: `${DRIVE_UPLOAD_URL}/files/${logFileId}?uploadType=media`,
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: logContent
            });
        } else {
            const metadata = { name: LOG_FILE_NAME, parents: [targetFolderId] };
            const boundary = '-----' + Math.random().toString(36).substring(2);
            const requestBody = new Blob([
                `--${boundary}\r\n`, 'Content-Type: application/json; charset=UTF-8\r\n\r\n', JSON.stringify(metadata),
                `\r\n--${boundary}\r\n`, 'Content-Type: application/json\r\n\r\n', logContent, `\r\n--${boundary}--`
            ]);
             await requestUrl({
                method: 'POST',
                url: `${DRIVE_UPLOAD_URL}/files?uploadType=multipart`,
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
                body: await requestBody.arrayBuffer()
            });
        }
    }

    async getFileIdByName(accessToken: string, name: string, parentId: string): Promise<string | null> {
        const query = `name = '${escapeQuery(name)}' and '${parentId}' in parents and trashed = false`;
        const response = await requestUrl({
            url: `${DRIVE_API_URL}/files?q=${encodeURIComponent(query)}&fields=files(id)`,
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        return response.json.files?.[0]?.id || null;
    }

    async getParents(accessToken: string, fileId: string): Promise<string[]> {
        const response = await requestUrl({
            url: `${DRIVE_API_URL}/files/${fileId}?fields=parents`,
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        return response.json.parents || [];
    }
    
    async getMetadata(accessToken: string, fileId: string, fields: string): Promise<any> {
        const response = await requestUrl({
            url: `${DRIVE_API_URL}/files/${fileId}?fields=${fields}`,
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        return response.json;
    }


    async getOrCreateFolder(accessToken: string, name: string, parentId: string): Promise<string> {
        if (!name) return parentId;
        const query = `name = '${escapeQuery(name)}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`;
        const searchUrl = `${DRIVE_API_URL}/files?q=${encodeURIComponent(query)}&fields=files(id)`;
        const searchResponse = await requestUrl({ method: 'GET', url: searchUrl, headers: { 'Authorization': `Bearer ${accessToken}` } });
        if (searchResponse.json.files.length > 0) return searchResponse.json.files[0].id;

        const createResponse = await requestUrl({
            method: 'POST',
            url: `${DRIVE_API_URL}/files`,
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
        });
        return createResponse.json.id;
    }
    
    async resolvePathToGdriveId(accessToken: string, currentFolderId: string, path: string): Promise<string> {
        if (!path) return currentFolderId;
        let parentId = currentFolderId;
        for (const part of path.split('/')) {
            if (part) {
                parentId = await this.getOrCreateFolder(accessToken, part, parentId);
            }
        }
        return parentId;
    }

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }

    async getAccessToken(): Promise<string | null> {
        if (!this.settings.refreshToken) { this.logout(); return null; }
        try {
            const response = await requestUrl({ method: 'POST', url: TOKEN_URL, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: this.settings.refreshToken, grant_type: 'refresh_token' }).toString() });
            return response.json.access_token;
        } catch (error) {
            console.error('Access token refresh error:', error);
            if ((error as any).response?.status === 400 || (error as any).response?.status === 401) this.logout();
            throw error;
        }
    }

    async login() {
        this.stopCallbackServer();
        if (this.isAuthenticating) { new Notice('Authentication is already in progress.'); return; }
        this.isAuthenticating = true;
        this.authState = randomBytes(16).toString('hex');
        this.authCodeVerifier = randomBytes(32).toString('base64url');
        try {
            const codeChallenge = createHash('sha256').update(this.authCodeVerifier).digest('base64url');
            const authUrl = new URL(AUTH_URL);
            authUrl.searchParams.append('client_id', CLIENT_ID);
            authUrl.searchParams.append('redirect_uri', REDIRECT_URI);
            authUrl.searchParams.append('response_type', 'code');
            authUrl.searchParams.append('scope', SCOPES.join(' '));
            authUrl.searchParams.append('state', this.authState);
            authUrl.searchParams.append('code_challenge', codeChallenge);
            authUrl.searchParams.append('code_challenge_method', 'S256');
            authUrl.searchParams.append('access_type', 'offline');
            authUrl.searchParams.append('prompt', 'consent');
            this.startCallbackServer();
            window.open(authUrl.toString());
        } catch (error) {
            console.error("Crypto error:", error);
            new Notice("Could not create crypto challenge.");
            this.isAuthenticating = false;
        }
    }

    startCallbackServer() {
        this.server = http.createServer(async (req, res) => {
            try {
                if (!req.url) throw new Error("Invalid request");
                const url = new URL(req.url, REDIRECT_URI);
                const code = url.searchParams.get('code');
                const receivedState = url.searchParams.get('state');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                if (receivedState !== this.authState) { res.end('<h1>오류: 상태 매개변수가 일치하지 않습니다. 보안 공격일 수 있습니다.</h1>'); return; }
                if (!code) { res.end('<h1>오류: 인증 코드를 찾을 수 없습니다.</h1>'); return; }
                res.end('<h1>성공! 이 창을 닫고 Obsidian으로 돌아가세요.</h1>');
                await this.exchangeCodeForToken(code, this.authCodeVerifier!);
            } catch (error) { console.error('Callback error:', error); } finally { this.stopCallbackServer(); this.isAuthenticating = false; }
        });
        this.server.setTimeout(180000, () => { this.stopCallbackServer(); this.isAuthenticating = false; });
        this.server.listen(42813, '127.0.0.1');
    }

    stopCallbackServer() { if (this.server) { this.server.close(); this.server = null; } }
    
    async exchangeCodeForToken(code: string, codeVerifier: string) {
        try {
            const response = await requestUrl({ method: 'POST', url: TOKEN_URL, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: code, code_verifier: codeVerifier, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI }).toString() });
            const tokens = response.json;
            if (tokens.refresh_token) {
                this.settings.refreshToken = tokens.refresh_token;
                await this.fetchUserEmail(tokens.access_token);
                this.settings.localShadow = { items: {}, deleted: {} };
                await this.saveSettings();
                new Notice('Successfully connected to Google Drive!');
                (this.app as any).setting.openTabById(this.manifest.id);
            }
        } catch (error) {
            console.error('Token exchange error:', error);
            new Notice('Failed to connect to Google Drive.');
        }
    }

    async fetchUserEmail(accessToken: string) {
        try {
            const response = await requestUrl({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/about?fields=user', headers: { 'Authorization': `Bearer ${accessToken}` } });
            this.settings.userEmail = response.json.user.emailAddress;
        } catch (error) {
            console.error('Failed to fetch user email:', error);
            this.settings.userEmail = 'Unknown';
        }
    }

    async logout() {
        this.settings.refreshToken = null;
        this.settings.userEmail = null;
        this.settings.automaticSync = false;
        this.settings.localShadow = { items: {}, deleted: {} };
        await this.saveSettings();
        this.toggleAutoSync();
        new Notice('Disconnected from Google Drive.');
    }
}

class GoogleDriveSyncSettingTab extends PluginSettingTab {
    plugin: GoogleDriveSyncPlugin;
    constructor(app: App, plugin: GoogleDriveSyncPlugin) { super(app, plugin); this.plugin = plugin; }
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Google Drive Sync Settings' });
        if (this.plugin.settings.refreshToken) {
            new Setting(containerEl)
                .setName('Connected Account')
                .setDesc(`Currently connected as: ${this.plugin.settings.userEmail || '...'}`)
                .addButton(button => button
                    .setButtonText('Logout')
                    .setWarning()
                    .onClick(async () => {
                        await this.plugin.logout();
                        this.display();
                    }));
            containerEl.createEl('h3', { text: 'Automatic Sync' });
            new Setting(containerEl)
                .setName('Enable automatic sync')
                .setDesc('Periodically sync your vault in the background.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.automaticSync)
                    .onChange(async (value) => {
                        this.plugin.settings.automaticSync = value;
                        await this.plugin.saveSettings();
                        this.plugin.toggleAutoSync();
                    }));
            new Setting(containerEl)
                .setName('Sync interval (minutes)')
                .setDesc('Set the time between automatic syncs.')
                .addText(text => {
                    text.inputEl.type = 'number';
                    text.setValue(String(this.plugin.settings.syncInterval))
                        .onChange(async (value) => {
                            const interval = parseInt(value, 10);
                            if (!isNaN(interval) && interval > 0) {
                                this.plugin.settings.syncInterval = interval;
                                await this.plugin.saveSettings();
                                this.plugin.toggleAutoSync();
                            }
                        });
                });
        } else {
            new Setting(containerEl)
                .setName('Connect to Google Drive')
                .setDesc('You need to authorize this plugin to access your Google Drive.')
                .addButton(button => button
                    .setButtonText('Connect')
                    .setCta()
                    .onClick(() => { this.plugin.login(); }));
        }
    }
}

