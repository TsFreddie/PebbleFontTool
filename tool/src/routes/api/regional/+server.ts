import { loadRegionalMapping, saveRegionalMapping } from '$lib/server/loader.js';
import { error } from '@sveltejs/kit';
import { pack, unpack } from 'msgpackr';

export const GET = async () => {
	const mapping = loadRegionalMapping();
	return new Response(pack(mapping) as Buffer<ArrayBuffer>, {
		headers: {
			'Content-Type': 'application/octet-stream'
		}
	});
};

export const POST = async ({ request }) => {
	const buffer = new Uint8Array(await request.arrayBuffer());
	const mapping = unpack(buffer);
	saveRegionalMapping(mapping as ReturnType<typeof loadRegionalMapping>);
	return new Response(null, { status: 204 });
};
