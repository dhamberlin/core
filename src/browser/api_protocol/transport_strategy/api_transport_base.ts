/*
Copyright 2017 OpenFin Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import { NackPayloadTemplate, AckFunc } from './ack';
declare var require: any;

const errors = require('../../../common/errors');

export interface ActionMap {
    [key: string]: Function;
}

export abstract class ApiTransportBase {

    public abstract registerMessageHandlers(actionMap: ActionMap): void;

    public abstract send(identity: any, payload: any): void

    public abstract onClientAuthenticated(cb: Function): void;

    public abstract onClientDisconnect(cb: Function): void;

    protected actionMap: ActionMap;

    protected abstract onMessage(id: number, data: any): void;

    protected abstract ackDecorator(id: number, messageId: number): AckFunc;

    protected abstract ackDecoratorSync(e: any, messageId: number): AckFunc;

    protected nackDecorator(ackFunction: AckFunc): AckFunc {
        return (err: any) => {
            const payload = new NackPayloadTemplate();

            if (typeof(err) === 'string') {
                payload.reason = err;
            } else {
                const errorObject = errors.errorToPOJO(err);
                payload.reason = errorObject.toString();
                payload.error = errorObject;
            }
            ackFunction(payload);
        };
    }
}
