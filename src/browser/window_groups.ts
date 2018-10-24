import { EventEmitter } from 'events';
import { BrowserWindow as BrowserWindowElectron } from 'electron';
import { createHash } from 'crypto';

import * as _ from 'underscore';
import { OpenFinWindow, Identity, BrowserWindow, ChildFrameInfo, PreloadScriptState } from '../shapes';
import { default as connectionManager, PeerRuntime } from './connection_manager';
import * as coreState from './core_state';
import * as log from './log';
import * as windowGroupsProxy from './window_groups_runtime_proxy';

let uuidSeed = 0;

export class WindowGroups extends EventEmitter {
    constructor() {
        super();
    }

    private _windowGroups: { [groupName: string]: { [windowName: string]: OpenFinWindow; } } = {};
    public getGroup = (groupName: string): OpenFinWindow[] => {
        return _.values(this._windowGroups[groupName]);
    };

    public getGroups = (): OpenFinWindow[][] => {
        return _.map(_.keys(this._windowGroups), (groupName) => {
            return this.getGroup(groupName);
        });
    };

    public hasProxyWindows = (groupName: string): boolean => {
        let hasProxyWindows = false;
        this.getGroup(groupName).forEach(win => {
            if (win.isProxy) {
                hasProxyWindows = true;
            }
        });

        return hasProxyWindows;
    };

    public getGroupHashName = (groupName: string): string => {

        const winGroup = this.getGroup(groupName);
        const hash = createHash('sha256');
        winGroup.map(x => x.browserWindow.nativeId)
            .sort()
            .forEach(i => hash.update(i));

        return hash.digest('hex');
    }

    // //create a proxy to a window that belongs to another runtime
    // private _createRuntimeWindowProxyWindow = async (identity: Identity): Promise<RuntimeProxyWindow> => {
    //     const { runtime: hostRuntime} = await connectionManager.resolveIdentity(identity);
    //     const remoteWindow = hostRuntime.fin.Window.wrapSync(identity);
    //     const nativeId = await remoteWindow.getNativeId();
    //     const proxyWindowOptions = {
    //         hwnd: '' + nativeId,
    //         uuid: identity.uuid,
    //         name: identity.name,
    //         url: ''
    //     };
    //     const browserwindow: any = new BrowserWindowElectron(proxyWindowOptions);

    //     browserwindow._options = proxyWindowOptions;
    //     const proxyWindow: OpenFinWindow = {
    //         _options : proxyWindowOptions,
    //         _window : <BrowserWindow>browserwindow,
    //         app_uuid: identity.uuid,
    //         browserWindow: <BrowserWindow>browserwindow,
    //         children: new Array<OpenFinWindow>(),
    //         frames: new Map<string, ChildFrameInfo>(),
    //         forceClose: false,
    //         groupUuid: '',
    //         hideReason: '',
    //         id: 0,
    //         name: identity.name,
    //         preloadScripts: new Array<PreloadScriptState>(),
    //         uuid: identity.uuid,
    //         mainFrameRoutingId: 0,
    //         isProxy: true
    //     };

    //     return {hostRuntime, proxyWindow};
    // }

    //TODO: Remove this
    // tslint:disable-next-line
    public joinGroup = async (source: Identity, target: Identity): Promise<void> => {
        const sourceWindow: OpenFinWindow = <OpenFinWindow>coreState.getWindowByUuidName(source.uuid, source.name);
        let targetWindow: OpenFinWindow = <OpenFinWindow>coreState.getWindowByUuidName(target.uuid, target.name);

        let runtimeProxyWindow;
        const sourceGroupName = sourceWindow.groupUuid;
        //identify if either the target or the source belong to a different runtime:
        if (!targetWindow) {
            //this try should be replaced by a general try here.
            try {
                runtimeProxyWindow = await windowGroupsProxy.getRuntimeProxyWindow(target);
                targetWindow = runtimeProxyWindow.window;

            } catch (err) {
                log.writeToLog('info', err);
            }
        }
        let targetGroupUuid = targetWindow.groupUuid;
        // cannot join a group with yourself
        if (sourceWindow.uuid === targetWindow.uuid && sourceWindow.name === targetWindow.name) {
            return;
        }

        // cannot join the same group you're already in
        if (sourceGroupName && targetGroupUuid && sourceGroupName === targetGroupUuid) {
            return;
        }

        // remove source from any group it belongs to
        if (sourceGroupName) {
            this._removeWindowFromGroup(sourceGroupName, sourceWindow);
        }

        // _addWindowToGroup returns the group's uuid that source was added to. in
        // the case where target doesn't belong to a group either, it generates
        // a brand new group and returns its uuid
        sourceWindow.groupUuid = this._addWindowToGroup(targetGroupUuid, sourceWindow);
        if (!targetGroupUuid) {
            targetWindow.groupUuid = targetGroupUuid = this._addWindowToGroup(sourceWindow.groupUuid, targetWindow);
        }

        const payload = generatePayload('join', sourceWindow, targetWindow, this.getGroup(sourceGroupName), this.getGroup(targetGroupUuid));
        if (sourceGroupName) {
            this.emit('group-changed', {
                groupUuid: sourceGroupName,
                payload
            });
        }
        if (targetGroupUuid) {
            this.emit('group-changed', {
                groupUuid: targetGroupUuid,
                payload
            });
        }

        // disband in the case where source leaves a group
        // with only one remaining window
        if (sourceGroupName) {
            this._handleDisbandingGroup(sourceGroupName);
        }

        //we just added a proxy window, we need to take some additional actions.
        if (runtimeProxyWindow && !runtimeProxyWindow.isRegistered) {
            const windowGroup = await windowGroupsProxy.getWindowGroupProxyWindows(runtimeProxyWindow);
            await windowGroupsProxy.registerRemoteProxyWindow(source, runtimeProxyWindow);
            windowGroup.forEach(pWin => {
                this._addWindowToGroup(sourceWindow.groupUuid, pWin.window);
            });
        }

    };

    public leaveGroup = (win: OpenFinWindow): void => {
        const groupUuid = win && win.groupUuid;

        // cannot leave a group if you don't belong to one
        if (!groupUuid) {
            return;
        }

        this._removeWindowFromGroup(groupUuid, win);
        if (groupUuid) {
            this.emit('group-changed', {
                groupUuid,
                payload: generatePayload('leave', win, win, this.getGroup(groupUuid), [])
            });
        }
        // updating the window's groupUuid after since it still needs to receive the event
        win.groupUuid = null;

        if (groupUuid) {
            this._handleDisbandingGroup(groupUuid);
        }
    };

    //TODO: Remove this
    // tslint:disable-next-line
    public mergeGroups = async (source: Identity, target: Identity): Promise<void> => {
        const sourceWindow: OpenFinWindow = <OpenFinWindow>coreState.getWindowByUuidName(source.uuid, source.name);
        let targetWindow: OpenFinWindow = <OpenFinWindow>coreState.getWindowByUuidName(target.uuid, target.name);
        let sourceGroupUuid = sourceWindow.groupUuid;
        let runtimeProxyWindow;
        //identify if either the target or the source belong to a different runtime:
        if (!targetWindow) {
            //this try should be replaced by a general try here.
            try {
                runtimeProxyWindow = await windowGroupsProxy.getRuntimeProxyWindow(target);
                targetWindow = runtimeProxyWindow.window;

            } catch (err) {
                log.writeToLog('info', err);
            }
        }
        let targetGroupUuid = targetWindow.groupUuid;

        // cannot merge a group with yourself
        if (source === target) {
            return;
        }

        // cannot merge the same group you're already in
        if (sourceGroupUuid && targetGroupUuid && sourceGroupUuid === targetGroupUuid) {
            return;
        }

        const payload = generatePayload('merge', sourceWindow, targetWindow,
            this.getGroup(sourceGroupUuid), this.getGroup(targetGroupUuid));
        if (sourceGroupUuid) {
            this.emit('group-changed', {
                groupUuid: sourceGroupUuid,
                payload
            });
        }
        if (targetGroupUuid) {
            this.emit('group-changed', {
                groupUuid: targetGroupUuid,
                payload
            });
        }

        // create a group if target doesn't already belong to one
        if (!targetGroupUuid) {
            targetWindow.groupUuid = targetGroupUuid = this._addWindowToGroup(targetGroupUuid, targetWindow);
        }

        // create a temporary group if source doesn't already belong to one
        if (!sourceGroupUuid) {
            sourceGroupUuid = this._addWindowToGroup(sourceGroupUuid, sourceWindow);
        }

        // update each of the windows from source's group to point
        // to target's group
        _.each(this.getGroup(sourceGroupUuid), (win) => {
            win.groupUuid = targetGroupUuid;
        });

        // shallow copy the windows from source's group to target's group
        _.extend(this._windowGroups[targetGroupUuid], this._windowGroups[sourceGroupUuid]);
        delete this._windowGroups[sourceGroupUuid];

        //we just added a proxy window, we need to take some additional actions.
        if (runtimeProxyWindow && !runtimeProxyWindow.isRegistered) {
            const windowGroup = await windowGroupsProxy.getWindowGroupProxyWindows(runtimeProxyWindow);
            await windowGroupsProxy.registerRemoteProxyWindow(source, runtimeProxyWindow);
            windowGroup.forEach(pWin => {
                this._addWindowToGroup(sourceWindow.groupUuid, pWin.window);
            });
        }
    };

    private _addWindowToGroup = (groupName: string, win: OpenFinWindow): string => {
        const _groupName = groupName || generateUuid();
        this._windowGroups[_groupName] = this._windowGroups[_groupName] || {};
        this._windowGroups[_groupName][win.name] = win;
        return _groupName;
    };

    private _removeWindowFromGroup = (uuid: string, win: OpenFinWindow): void => {
        delete this._windowGroups[uuid][win.name];
    };

    private _handleDisbandingGroup = (groupUuid: string): void => {
        if (this.getGroup(groupUuid).length < 2) {
            const lastWindow = this.getGroup(groupUuid)[0];
            this._removeWindowFromGroup(groupUuid, lastWindow);
            this.emit('group-changed', {
                groupUuid,
                payload: generatePayload('disband', lastWindow, lastWindow, [], [])
            });
            lastWindow.groupUuid = null;
            delete this._windowGroups[groupUuid];
        }
    };
}


// Helpers

function generateUuid(): string {
    return `group${uuidSeed++}`;
}

export interface WindowIdentifier {
    appUuid: string;
    windowName: string;
}
export interface GroupChangedPayload {
    reason: string;
    sourceGroup: WindowIdentifier[];
    sourceWindowAppUuid: string;
    sourceWindowName: string;
    targetGroup: WindowIdentifier[];
    targetWindowAppUuid: string;
    targetWindowName: string;
    topic: 'window';
    type: 'group-changed';
}

function generatePayload(reason: string,
    sourceWindow: OpenFinWindow,
    targetWindow: OpenFinWindow,
    sourceGroup: OpenFinWindow[],
    targetGroup: OpenFinWindow[]
): GroupChangedPayload {
    return {
        reason,
        sourceGroup: mapEventWindowGroups(sourceGroup),
        sourceWindowAppUuid: sourceWindow.app_uuid,
        sourceWindowName: sourceWindow.name,
        targetGroup: mapEventWindowGroups(targetGroup),
        targetWindowAppUuid: targetWindow.app_uuid,
        targetWindowName: targetWindow.name,
        topic: 'window',
        type: 'group-changed'
    };
}

function mapEventWindowGroups(group: OpenFinWindow[]): WindowIdentifier[] {
    return _.map(group, (win) => {
        return {
            appUuid: win.app_uuid,
            windowName: win.name
        };
    });
}

export default new WindowGroups();
