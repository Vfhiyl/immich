import { IncomingMessage } from 'node:http';

/**
The requests that came in on the port of the mobile app in self-signed mode (docs: administration/self-signed-tls): that port
serves the app's API only, without the web, the administration, password sign-in or shared links
*/
const appPortRequests = new WeakSet<IncomingMessage>();

export const markAppPortRequest = (request: IncomingMessage) => {
  appPortRequests.add(request);
};

export const isAppPortRequest = (request: IncomingMessage) => appPortRequests.has(request);
