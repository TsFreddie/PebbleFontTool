import { loadFreq } from '$lib/server/loader';
import { json, text } from '@sveltejs/kit';

export const GET = () => {
	return json(loadFreq());
};
