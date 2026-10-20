import { Readable } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import {
  bufferZipSource,
  deliveryName,
  openEntryStream,
  openZip,
  pathRefusal,
  readEntry,
  s3ZipSource,
  ZipRejectedError,
  type EntryKind,
} from '~/server/utils/service-deal-zip';
import {
  SERVICE_ZIP_MAX_ENTRIES,
  SERVICE_ZIP_MAX_ENTRY_BYTES,
  SERVICE_ZIP_MAX_IMAGE_BYTES,
  SERVICE_ZIP_MAX_TOTAL_BYTES,
} from '~/shared/constants/creator-services.constants';
import {
  buildZip,
  JPEG_BYTES,
  MP4_BYTES,
  PNG_BYTES,
  symlinkAttributes,
  type FixtureEntry,
} from './zip-fixture';

/**
 * The zip reader against real archives built in the test. Each refusal is asserted by its own
 * message, so a test cannot pass because some OTHER rule happened to fire.
 */

const refusal = async (entries: FixtureEntry[], read = true) => {
  const opened = await openZip(bufferZipSource(buildZip(entries)));
  try {
    const budget = { used: 0 };
    if (read)
      for (const entry of opened.entries)
        await readEntry(opened.zipfile, entry, budget, () => false);
  } finally {
    opened.zipfile.close();
  }
};
const rejects = (promise: Promise<unknown>, message: RegExp) =>
  expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof ZipRejectedError && message.test(error.message)
  );

describe('paths', () => {
  it.each([
    ['a plain path', 'a/b/c.txt', null],
    ['a name with dots', 'a..b/c..txt', null],
    ['a parent segment', 'a/../b', 'outside'],
    ['a parent segment after a backslash', 'a\\..\\b', 'outside'],
    ['an absolute path', '/x', 'absolute'],
    ['a drive path', 'D:\\x', 'absolute'],
    ['a NUL', 'a\0b', 'invalid name'],
    ['a very long name', 'a'.repeat(513), 'invalid name'],
  ])('%s', (_label, path, expected) => {
    const reason = pathRefusal(path);
    if (expected === null) expect(reason).toBeNull();
    else
      expect(reason).toMatch(
        { outside: /outside/, absolute: /absolute/, 'invalid name': /invalid name/ }[expected]!
      );
  });
});

describe('a plain archive', () => {
  it('lists its files, and reads them back with their kinds', async () => {
    const png = PNG_BYTES();
    const opened = await openZip(
      bufferZipSource(
        buildZip([
          { name: 'folder/' },
          { name: 'folder/a.png', data: png },
          { name: 'b.JPG', data: JPEG_BYTES(), method: 'store' },
          { name: 'notes.txt', data: Buffer.from('hello there, this is text') },
          { name: 'tiny.txt', data: Buffer.from('hi') },
        ])
      )
    );
    expect(opened.entries.map((e) => [e.index, e.path])).toEqual([
      [1, 'folder/a.png'],
      [2, 'b.JPG'],
      [3, 'notes.txt'],
      [4, 'tiny.txt'],
    ]);
    const kinds: EntryKind[] = [];
    const budget = { used: 0 };
    for (const entry of opened.entries) {
      const read = await readEntry(opened.zipfile, entry, budget, (kind) => kind === 'image');
      kinds.push(read.kind);
      if (read.kind === 'image') expect(read.data?.byteLength).toBe(entry.size);
      else expect(read.data).toBeNull();
    }
    expect(kinds).toEqual(['image', 'image', 'other', 'other']);
    expect(budget.used).toBeGreaterThan(0);
    opened.zipfile.close();
  });

  it('hands back exactly the bytes of an image', async () => {
    const png = PNG_BYTES(5000);
    const opened = await openZip(bufferZipSource(buildZip([{ name: 'a.png', data: png }])));
    const read = await readEntry(opened.zipfile, opened.entries[0], { used: 0 }, () => true);
    expect(read.data?.equals(png)).toBe(true);
    opened.zipfile.close();
  });
});

describe('what an archive says about itself', () => {
  it('accepts exactly the entry limit and refuses one more', async () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `f${i}.txt`,
        data: Buffer.from('x'),
        method: 'store' as const,
      }));
    const ok = await openZip(bufferZipSource(buildZip(many(SERVICE_ZIP_MAX_ENTRIES))));
    expect(ok.entries).toHaveLength(SERVICE_ZIP_MAX_ENTRIES);
    ok.zipfile.close();
    await rejects(refusal(many(SERVICE_ZIP_MAX_ENTRIES + 1), false), /too many files/);
  });

  it('refuses an encrypted entry', async () => {
    await rejects(
      refusal([{ name: 'a.txt', data: Buffer.from('x'), flags: 1 }], false),
      /Password/
    );
  });

  it.each([
    ['a parent path', '../evil.txt'],
    ['a path that climbs out later', 'a/b/../../../evil.txt'],
    ['an absolute path', '/etc/passwd'],
    ['a drive path', 'C:\\Windows\\x.txt'],
    ['a backslash parent path', '..\\evil.txt'],
  ])('refuses %s', async (_label, name) => {
    await rejects(
      refusal([{ name, data: Buffer.from('x') }], false),
      /absolute paths|outside the archive/
    );
  });

  it('refuses a symbolic link', async () => {
    await rejects(
      refusal(
        [
          {
            name: 'link',
            data: Buffer.from('/etc/passwd'),
            externalAttributes: symlinkAttributes(),
          },
        ],
        false
      ),
      /symbolic links/
    );
  });

  it.each(['inner.zip', 'inner.RAR', 'a.7z', 'a.tar', 'a.tar.gz', 'a.tgz'])(
    'refuses a nested archive named %s',
    async (name) => {
      await rejects(refusal([{ name, data: Buffer.from('x') }], false), /nested/);
    }
  );

  it.each(['m.safetensors', 'm.ckpt', 'm.pt', 'm.pth', 'm.gguf', 'm.bin', 'sub/m.SafeTensors'])(
    'refuses the model file %s inside the archive',
    async (name) => {
      await rejects(refusal([{ name, data: Buffer.from('x') }], false), /Model files/);
    }
  );

  it.each(['c.mp4', 'c.mov', 'c.webm', 'c.mkv', 'c.avi'])('refuses the video %s', async (name) => {
    await rejects(refusal([{ name, data: Buffer.from('x') }], false), /Video/);
  });

  it.each(['a.bmp', 'a.tiff', 'a.avif', 'a.heic', 'a.svg'])(
    'refuses the image format %s it cannot make a scan copy of',
    async (name) => {
      await rejects(refusal([{ name, data: Buffer.from('x') }], false), /image format/);
    }
  );

  it('refuses a compression method it cannot read', async () => {
    await rejects(
      refusal([{ name: 'a.txt', data: Buffer.from('x'), method: 12 }], false),
      /compression method/
    );
  });

  it('refuses an archive with extra trailing data', async () => {
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x'.repeat(100)) }], {
      trailing: Buffer.from('trailing'),
    });
    await rejects(openZip(bufferZipSource(zip)), /not a valid/);
  });

  it('refuses what is not a zip, and a zip cut short', async () => {
    await rejects(
      openZip(bufferZipSource(Buffer.from('definitely not a zip file'))),
      /not a valid/
    );
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('x'.repeat(100)) }]);
    await rejects(openZip(bufferZipSource(zip.subarray(0, zip.byteLength - 10))), /not a valid/);
  });

  it('refuses a declared size over the image cap, and over the general cap', async () => {
    await rejects(
      refusal(
        [
          {
            name: 'a.png',
            data: PNG_BYTES(),
            declaredSize: SERVICE_ZIP_MAX_IMAGE_BYTES + 1,
            declaredCompressedSize: SERVICE_ZIP_MAX_IMAGE_BYTES + 1,
          },
        ],
        false
      ),
      /too large/
    );
    await rejects(
      refusal(
        [
          {
            name: 'a.txt',
            data: Buffer.from('x'),
            declaredSize: SERVICE_ZIP_MAX_ENTRY_BYTES + 1,
            declaredCompressedSize: SERVICE_ZIP_MAX_ENTRY_BYTES + 1,
          },
        ],
        false
      ),
      /too large/
    );
    // The same size is fine for a file that is not an image, and the image cap itself is fine.
    for (const [name, size] of [
      ['a.txt', SERVICE_ZIP_MAX_IMAGE_BYTES + 1],
      ['a.png', SERVICE_ZIP_MAX_IMAGE_BYTES],
    ] as const) {
      const ok = await openZip(
        bufferZipSource(
          buildZip([{ name, data: PNG_BYTES(), declaredSize: size, declaredCompressedSize: size }])
        )
      );
      ok.zipfile.close();
    }
  });

  it('refuses a declared ratio over the limit, and one just under it passes', async () => {
    // 30 MB of zeros deflates to about 30 KB: far past 100:1.
    await rejects(
      refusal([{ name: 'a.txt', data: Buffer.alloc(30 * 1024 * 1024) }], false),
      /compressed beyond/
    );
    // Incompressible data of the same size is stored at 1:1.
    const ok = await openZip(
      bufferZipSource(
        buildZip([{ name: 'a.txt', data: Buffer.alloc(2 * 1024 * 1024, 1), method: 'store' }])
      )
    );
    ok.zipfile.close();
  });

  it('can leave the ratio unasked, for an archive the server built itself', async () => {
    const entries = [
      {
        name: 'a.txt',
        data: Buffer.from('x'),
        declaredSize: 30 * 1024 * 1024,
        declaredCompressedSize: 1000,
      },
    ];
    await rejects(openZip(bufferZipSource(buildZip(entries))), /compressed beyond/);
    const opened = await openZip(bufferZipSource(buildZip(entries)), { checkRatio: false });
    expect(opened.entries).toHaveLength(1);
    opened.zipfile.close();
  });

  it('refuses a declared total over the limit', async () => {
    const each = SERVICE_ZIP_MAX_ENTRY_BYTES;
    const count = Math.ceil(SERVICE_ZIP_MAX_TOTAL_BYTES / each) + 1;
    await rejects(
      refusal(
        Array.from({ length: count }, (_, i) => ({
          name: `f${i}.txt`,
          data: Buffer.from('x'),
          method: 'store' as const,
          declaredSize: each,
          declaredCompressedSize: each,
        })),
        false
      ),
      /too large once unpacked/
    );
  });
});

describe('what an archive actually does', () => {
  it('stops an entry that inflates past its ratio though its header says it is small', async () => {
    // The header claims 500 bytes. The data is 60 MB of zeros in a tiny deflate stream.
    await rejects(
      refusal([{ name: 'a.txt', data: Buffer.alloc(60 * 1024 * 1024), declaredSize: 500 }]),
      /compressed beyond/
    );
  });

  it('stops an image that is bigger than the image cap though its header says it is small', async () => {
    const data = Buffer.concat([PNG_BYTES(0), Buffer.alloc(SERVICE_ZIP_MAX_IMAGE_BYTES, 3)]);
    await rejects(
      refusal([{ name: 'a.png', data, method: 'store', declaredSize: 1000 }]),
      /too large/
    );
  });

  it('stops that image too when the bytes arrive in small pieces, as a bucket sends them', async () => {
    const data = Buffer.concat([PNG_BYTES(0), Buffer.alloc(SERVICE_ZIP_MAX_IMAGE_BYTES, 3)]);
    const whole = bufferZipSource(
      buildZip([{ name: 'a.png', data, method: 'store', declaredSize: 1000 }])
    );
    const pieces = {
      size: whole.size,
      readRange: (start: number, end: number) =>
        Readable.from(
          (async function* () {
            for await (const chunk of whole.readRange(start, end)) {
              const bytes = chunk as Buffer;
              for (let at = 0; at < bytes.byteLength; at += 16 * 1024)
                yield bytes.subarray(at, at + 16 * 1024);
            }
          })()
        ),
    };
    const opened = await openZip(pieces);
    await rejects(
      readEntry(opened.zipfile, opened.entries[0], { used: 0 }, () => false),
      /too large/
    );
    opened.zipfile.close();
  });

  it('stops a general entry past its cap though its header says it is small', async () => {
    const data = Buffer.alloc(SERVICE_ZIP_MAX_ENTRY_BYTES + 1, 5);
    await rejects(
      refusal([{ name: 'a.txt', data, method: 'store', declaredSize: 1000 }]),
      /too large/
    );
  });

  it('counts every entry against one archive-wide budget', async () => {
    const opened = await openZip(
      bufferZipSource(buildZip([{ name: 'a.txt', data: Buffer.alloc(100, 1), method: 'store' }]))
    );
    // 10 bytes of budget left: a 100-byte entry crosses it.
    await rejects(
      readEntry(
        opened.zipfile,
        opened.entries[0],
        { used: SERVICE_ZIP_MAX_TOTAL_BYTES - 10 },
        () => false
      ),
      /too large once unpacked/
    );
    // With room to spare the same entry reads.
    const read = await readEntry(opened.zipfile, opened.entries[0], { used: 0 }, () => false);
    expect(read.bytes).toBe(100);
    opened.zipfile.close();
  });

  it('judges an entry by its bytes, not its name', async () => {
    // A video, an archive and an unsupported image, each called something harmless.
    await rejects(refusal([{ name: 'holiday.png', data: MP4_BYTES() }]), /Video|not the image/);
    await rejects(refusal([{ name: 'clip.dat', data: MP4_BYTES() }]), /Video/);
    await rejects(
      refusal([
        {
          name: 'notes.txt',
          data: Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(40)]),
        },
      ]),
      /nested/
    );
    await rejects(
      refusal([{ name: 'scan.dat', data: Buffer.concat([Buffer.from('BM'), Buffer.alloc(40)]) }]),
      /image format/
    );
    // A file called an image that is not one.
    await rejects(
      refusal([{ name: 'a.png', data: Buffer.from('this is not a png at all') }]),
      /not the image/
    );
    // An image with an ordinary name is an image: it is judged as one even though it is not named so.
    const opened = await openZip(
      bufferZipSource(buildZip([{ name: 'readme.dat', data: PNG_BYTES() }]))
    );
    const read = await readEntry(opened.zipfile, opened.entries[0], { used: 0 }, () => false);
    expect(read.kind).toBe('image');
    opened.zipfile.close();
  });

  it('judges an entry shorter than the sniffed head', async () => {
    await rejects(refusal([{ name: 'a.png', data: Buffer.from('hi') }]), /not the image/);
    const opened = await openZip(
      bufferZipSource(buildZip([{ name: 'a.txt', data: Buffer.from('hi') }]))
    );
    const read = await readEntry(opened.zipfile, opened.entries[0], { used: 0 }, () => false);
    expect(read).toMatchObject({ kind: 'other', bytes: 2 });
    opened.zipfile.close();
  });
});

describe('reading from the bucket', () => {
  it('asks for exactly the range, and for nothing when the range is empty', async () => {
    const send = vi.fn(async () => ({ Body: Readable.from([Buffer.from('abc')]) }));
    const source = s3ZipSource({ send } as never, 'bucket', 'key', 100);
    const chunks: Buffer[] = [];
    for await (const chunk of source.readRange(10, 20)) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('abc');
    const command = (send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }])[0];
    expect(command.input).toMatchObject({ Bucket: 'bucket', Key: 'key', Range: 'bytes=10-19' });
    const empty: unknown[] = [];
    for await (const chunk of source.readRange(5, 5)) empty.push(chunk);
    expect(empty).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fails the stream when the bucket does', async () => {
    const send = vi.fn(async () => {
      throw new Error('down');
    });
    const source = s3ZipSource({ send } as never, 'bucket', 'key', 100);
    await expect(
      (async () => {
        for await (const chunk of source.readRange(0, 10)) void chunk;
      })()
    ).rejects.toThrow('down');
  });
});

describe('the name a file has in the archive the server builds', () => {
  it.each([
    ['a plain path', 'a/b.txt', 'a/b.txt'],
    ['a leading dot-slash', './a.txt', 'a.txt'],
    ['repeated leading dot-slashes', './././a.txt', 'a.txt'],
    ['doubled separators', 'a//b///c.txt', 'a/b/c.txt'],
    ['backslashes', 'a\\b.txt', 'a/b.txt'],
    ['a decomposed accent', 'cafe\u0301.txt', 'caf\u00e9.txt'],
  ])('tidies %s', (_label, path, expected) => {
    expect(deliveryName(path)).toBe(expected);
  });

  it.each([
    ['nothing', ''],
    ['only a dot-slash', './'],
    ['a directory', 'a/b/'],
    ['a parent path', '../a.txt'],
    ['a parent path after tidying', './../a.txt'],
    ['an absolute path', '/a.txt'],
  ])('refuses %s', (_label, path) => {
    expect(() => deliveryName(path)).toThrow(ZipRejectedError);
  });
});

describe('copying an entry out', () => {
  const drain = async (stream: AsyncIterable<unknown>) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };
  const open = async (entries: FixtureEntry[]) => {
    const opened = await openZip(bufferZipSource(buildZip(entries)));
    return opened;
  };

  it('hands over exactly the bytes of the entry', async () => {
    const data = Buffer.from('some bytes worth copying '.repeat(50));
    const opened = await open([{ name: 'a.txt', data }]);
    const copied = await drain(
      await openEntryStream(opened.zipfile, opened.entries[0], { used: 0 })
    );
    expect(copied.equals(data)).toBe(true);
    opened.zipfile.close();
  });

  it('stops an entry that exceeds its compression ratio as it is read', async () => {
    const opened = await open([
      { name: 'a.txt', data: Buffer.alloc(60 * 1024 * 1024), declaredSize: 500 },
    ]);
    await rejects(
      drain(await openEntryStream(opened.zipfile, opened.entries[0], { used: 0 })),
      /compressed beyond/
    );
    opened.zipfile.close();
  });

  it('stops an entry past the size cap for its kind as it is read', async () => {
    const image = await open([
      {
        name: 'a.png',
        data: Buffer.alloc(SERVICE_ZIP_MAX_IMAGE_BYTES + 1, 3),
        method: 'store',
        declaredSize: 1000,
      },
    ]);
    await rejects(
      drain(await openEntryStream(image.zipfile, image.entries[0], { used: 0 })),
      /too large/
    );
    image.zipfile.close();
    // The same size is within the general cap for a file that is not an image.
    const other = await open([
      {
        name: 'a.dat',
        data: Buffer.alloc(SERVICE_ZIP_MAX_IMAGE_BYTES + 1, 3),
        method: 'store',
        declaredSize: 1000,
      },
    ]);
    const copied = await drain(await openEntryStream(other.zipfile, other.entries[0], { used: 0 }));
    expect(copied.byteLength).toBe(SERVICE_ZIP_MAX_IMAGE_BYTES + 1);
    other.zipfile.close();
  });

  it('fails when the source of the archive fails part-way, rather than waiting for ever', async () => {
    const whole = bufferZipSource(
      buildZip([{ name: 'a.txt', data: Buffer.from('some bytes '.repeat(2000)), method: 'store' }])
    );
    let failing = false;
    const flaky = {
      size: whole.size,
      readRange: (start: number, end: number) => {
        const stream = whole.readRange(start, end);
        // Small reads (headers) pass; the read of the entry's bytes breaks.
        if (!failing || end - start < 1000) return stream;
        return Readable.from(
          (async function* () {
            yield Buffer.from('partial');
            throw new Error('connection reset');
          })()
        );
      },
    };
    const opened = await openZip(flaky);
    failing = true;
    await expect(
      drain(await openEntryStream(opened.zipfile, opened.entries[0], { used: 0 }))
    ).rejects.toThrow('connection reset');
    opened.zipfile.close();
  });

  it('counts against the archive-wide budget', async () => {
    const opened = await open([{ name: 'a.txt', data: Buffer.alloc(100, 1), method: 'store' }]);
    await rejects(
      drain(
        await openEntryStream(opened.zipfile, opened.entries[0], {
          used: SERVICE_ZIP_MAX_TOTAL_BYTES - 10,
        })
      ),
      /too large once unpacked/
    );
    opened.zipfile.close();
  });
});
