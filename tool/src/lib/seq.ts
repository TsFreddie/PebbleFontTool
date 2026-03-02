import { browser } from '$app/environment';
import seq from './seq.txt?raw';

const addUnique = <T>(arr: T[], item: T) => {
	if (!arr.includes(item)) arr.push(item);
};

function isMark(char: string) {
	if (char.length !== 1) {
		return false;
	}

	const codePoint = char.codePointAt(0);

	if (!codePoint) {
		return false;
	}

	if (codePoint >= 0 && codePoint <= 127) {
		return true;
	}

	return false;
}

const segmentor = new Intl.Segmenter('zh', { granularity: 'grapheme' });

const combiner = (parts: string[]) => {
	const result: string[] = [];

	let expectedCount = 0;
	let current = '';

	for (let i = 0; i < parts.length; i++) {
		const char = parts[i];
		if ('⿰⿱⿴⿵⿶⿷⿸⿹⿺⿻'.includes(char)) {
			expectedCount += 3;
		} else if ('⿲⿳'.includes(char)) {
			expectedCount += 4;
		}

		current += char;

		if (expectedCount > 0) {
			expectedCount--;
		} else if (current) {
			result.push(current);
			current = '';
		}
	}

	if (current) {
		result.push(current);
	}

	return result;
};

const process = (part: string) => {
	const chars = Array.from(segmentor.segment(part.slice(1))).map((seg) => seg.segment);

	const result = [];
	let current = '';

	for (const char of chars) {
		if (isMark(char)) {
			current += char;
		} else {
			if (current) {
				result.push(current);
				current = '';
			}
			current += char;
		}
	}

	if (current) {
		result.push(current);
	}

	const combined = combiner(result);
	if (combined.length !== 2) return ['', ''];

	return combined;
};

// IDC sequence database
export const SEQS = Object.fromEntries(
	seq
		.split('\n')
		.map((line) => {
			const [char, ...seqs] = line.split('\t');
			const possibleParts: string[] = [];

			for (const part of seqs) {
				if (part.startsWith('⿰')) {
					const [left, right] = process(part);
					addUnique(possibleParts, left + '<');
					addUnique(possibleParts, right + '>');
				} else if (part.startsWith('⿱')) {
					const [top, bottom] = process(part);
					addUnique(possibleParts, top + '^');
					addUnique(possibleParts, bottom + 'v');
				} else if (
					part.startsWith('⿸') ||
					part.startsWith('⿹') ||
					part.startsWith('⿺') ||
					part.startsWith('⿴') ||
					part.startsWith('⿵') ||
					part.startsWith('⿶') ||
					part.startsWith('⿷')
				) {
					const [outside, inside] = process(part);
					addUnique(possibleParts, outside + 'o');
					addUnique(possibleParts, inside + 'i');
				}
			}
			return [char.codePointAt(0)!, possibleParts] as [number, string[]];
		})
		.filter((s) => s[1].length > 0)
);

if (browser) {
	window.SEQS = SEQS;
}
