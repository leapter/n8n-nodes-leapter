// Forwards localhost:<port> inside the n8n container to the same port on the Docker host, for
// each port in RELAY_PORTS. The node refuses http:// except on localhost, and a local cluster
// names http://localhost:<port> as its run address, so the container's localhost must reach the
// host. Exits at once when RELAY_PORTS is empty (a remote https cluster needs no relay).
const net = require('net');

for (const port of (process.env.RELAY_PORTS ?? '').split(/\s+/).filter(Boolean).map(Number)) {
	net
		.createServer((client) => {
			const upstream = net.connect(port, 'host.docker.internal');
			client.pipe(upstream).pipe(client);
			upstream.on('error', () => client.destroy());
			client.on('error', () => upstream.destroy());
		})
		.listen(port); // all addresses: localhost may resolve to ::1; the port is not published
}
