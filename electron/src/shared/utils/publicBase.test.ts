import { describe, expect, it } from 'vitest';
import { basePathPrefix, publicAssetUrl } from './publicBase';
import { _resolveApiBase } from '../api/client';

describe('build base path helpers', () => {
  it('keeps root-relative URLs for the default and relative bases', () => {
    for (const base of [undefined, '', '/', './', 'https://cdn.example/x/', '//cdn.example/']) {
      expect(basePathPrefix(base)).toBe('');
      expect(publicAssetUrl('aec-worklet.js', base)).toBe('/aec-worklet.js');
    }
  });

  it('prefixes static files and same-origin routes for a subpath build', () => {
    expect(basePathPrefix('/jinvoice/app/')).toBe('/jinvoice/app');
    expect(basePathPrefix('/jinvoice/app')).toBe('/jinvoice/app');
    expect(publicAssetUrl('aec-worklet.js', '/jinvoice/app/')).toBe('/jinvoice/app/aec-worklet.js');
    expect(publicAssetUrl('/donation_progress.json', '/jinvoice/app/')).toBe(
      '/jinvoice/app/donation_progress.json',
    );
  });

  it('uses the vitest base (/) when no base is passed', () => {
    expect(publicAssetUrl('aec-worklet.js')).toBe('/aec-worklet.js');
  });

  it('resolves the shared client API base under the subpath', () => {
    const win = { location: { origin: 'https://imist.co.kr', hostname: 'imist.co.kr' } };
    expect(_resolveApiBase({ BASE_URL: '/jinvoice/app/' }, win)).toBe('https://imist.co.kr/jinvoice/app');
    expect(_resolveApiBase({ BASE_URL: '/' }, win)).toBe('https://imist.co.kr');
    expect(
      _resolveApiBase(
        { BASE_URL: '/jinvoice/app/' },
        { ...win, __OMNIVOICE_API_BASE__: 'https://imist.co.kr/jinvoice/app/' },
      ),
    ).toBe('https://imist.co.kr/jinvoice/app');
  });
});
