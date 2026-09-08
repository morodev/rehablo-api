import assert from 'node:assert/strict';
import test from 'node:test';
import { detectNoteImageMime, hasExpectedNoteImageExtension, validateNoteImageFile } from './noteImageFile.js';

test('detects the supported note image signatures', () => {
    assert.equal(detectNoteImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
    assert.equal(detectNoteImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
    assert.equal(detectNoteImageMime(Buffer.from('GIF89a')), 'image/gif');
    assert.equal(detectNoteImageMime(Buffer.from('RIFF0000WEBP')), 'image/webp');
});

test('rejects a mismatched MIME type or extension', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(validateNoteImageFile({ buffer: png, mimetype: 'image/jpeg', originalname: 'photo.jpg' }), null);
    assert.equal(validateNoteImageFile({ buffer: png, mimetype: 'image/png', originalname: 'photo.jpg' }), null);
    assert.equal(validateNoteImageFile({ buffer: png, mimetype: 'image/png', originalname: 'photo.png' }), 'image/png');
    assert.equal(hasExpectedNoteImageExtension('PHOTO.JPEG', 'image/jpeg'), true);
});
