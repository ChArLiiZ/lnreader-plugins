import { load as parseHTML } from 'cheerio';
import { fetchText } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { defaultCover } from '@libs/defaultCover';
import { encode } from 'urlencode';
import { storage } from '@libs/storage';

type NovelListItem = Plugin.NovelItem & { genres?: string };
type TagOption = { label: string; value: string };

const COLLECTED_TAGS_KEY = 'wenku8_collected_tags';

class Wenku8 implements Plugin.PluginBase {
  id = 'wenku8';
  name = 'Wenku8';
  icon = 'src/cn/quanben/icon.png';
  site = 'https://www.wenku8.net';
  version = '1.1.0';
  webStorageUtilized = true;

  private refreshTagOptions(): void {
    const saved: string[] = storage.get(COLLECTED_TAGS_KEY) || [];
    this.filters.customTag.options = saved
      .slice()
      .sort((left, right) => left.localeCompare(right, 'zh-Hant'))
      .map(tag => ({ label: tag, value: tag }));
  }

  private collectTags(tags: string[]): void {
    if (tags.length === 0) return;

    const saved: string[] = storage.get(COLLECTED_TAGS_KEY) || [];
    const tagSet = new Set(saved);
    let changed = false;

    tags.forEach(tag => {
      const normalized = this.cleanText(tag);
      if (!normalized || tagSet.has(normalized)) return;
      tagSet.add(normalized);
      changed = true;
    });

    if (changed) {
      storage.set(COLLECTED_TAGS_KEY, Array.from(tagSet));
      this.refreshTagOptions();
    }
  }

  private getSelectedTag(
    filters?: Plugin.PopularNovelsOptions<typeof this.filters>['filters'],
  ): string | undefined {
    const customTag = filters?.customTag?.value as unknown;
    if (Array.isArray(customTag)) {
      const selected = customTag.find(
        value => typeof value === 'string' && value.trim() !== '',
      );
      return typeof selected === 'string' ? selected.trim() : undefined;
    }
    if (typeof customTag === 'string' && customTag.trim() !== '') {
      return customTag.trim();
    }
    return undefined;
  }

  private cleanText(text?: string | null): string {
    return text?.replace(/\s+/g, ' ').trim() || '';
  }

  private makeAbsolute(url?: string | null): string {
    if (!url) return defaultCover;
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('/')) return `${this.site}${url}`;
    return `${this.site}/${url}`;
  }

  private isBlocked(body: string): boolean {
    return (
      body === '' ||
      body.includes('Just a moment') ||
      body.includes('Enable JavaScript and cookies to continue') ||
      body.includes('window._cf_chl_opt') ||
      body.includes('网站已停用')
    );
  }

  private getLoginPromptNovel(path: string): Plugin.SourceNovel {
    return {
      path,
      name: 'Wenku8 Login Required',
      cover: defaultCover,
      summary:
        'Wenku8 currently requires a logged-in browser session.\n\n' +
        'Open this source in WebView, complete the login, then refresh the novel page.',
      chapters: [],
    };
  }

  private async fetchPage(url: string, encoding?: string): Promise<string> {
    return await fetchText(
      url,
      {
        headers: {
          Referer: this.site,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        },
      },
      encoding,
    );
  }

  private parseWordCount(text: string): number | undefined {
    const match = text.match(/([\d,]+)\s*字/);
    if (!match) return undefined;

    const count = parseInt(match[1].replace(/,/g, ''), 10);
    return Number.isNaN(count) ? undefined : count;
  }

  private splitTags(text: string): string[] {
    return text
      .split(/[/,\s]+/)
      .map(tag => tag.trim())
      .filter(Boolean);
  }

  private extractField(
    text: string,
    labels: string[],
    stopLabels: string[],
  ): string {
    const escapedLabels = labels.map(label =>
      label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    );
    const escapedStops = stopLabels.map(label =>
      label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    );
    const pattern = new RegExp(
      `(?:${escapedLabels.join('|')})[:：]?\\s*(.+?)(?=(?:${escapedStops.join('|')})[:：]?|$)`,
      'i',
    );

    return this.cleanText(text.match(pattern)?.[1]);
  }

  private parseGridResults(body: string): Plugin.NovelItem[] {
    const $ = parseHTML(body);
    const novels: Plugin.NovelItem[] = [];

    $('table.grid td').each((_i, el) => {
      const cell = $(el);
      const html = cell.html() || '';
      const text = this.cleanText(cell.text());

      const path =
        cell.find('a[href*="/book/"]').first().attr('href') ||
        html.match(/href="(\/book\/\d+\.htm)"/)?.[1];
      if (!path) return;

      const cover =
        cell.find('img').first().attr('src') ||
        html.match(/<img[^>]+src="([^"]+)"/)?.[1];
      const name =
        cell.find('a[title]').first().attr('title') ||
        cell.find('b').first().text() ||
        html.match(/title="([^"]+)"/)?.[1] ||
        '';
      const author = this.extractField(
        text,
        ['作者'],
        ['标签', '標籤', 'Tags', '状态', '狀態'],
      );
      const tags = this.extractField(
        text,
        ['Tags', '标签', '標籤'],
        ['作者', '状态', '狀態', '全文长度', '字数', '字數'],
      );
      const length = this.extractField(
        text,
        ['全文长度', '字数', '字數'],
        ['作者', '标签', '標籤', 'Tags', '状态', '狀態'],
      );

      const novel: NovelListItem = {
        name: this.cleanText(name),
        path,
        cover: this.makeAbsolute(cover),
      };

      const infoParts: string[] = [];
      if (length) infoParts.push(length);
      if (author) infoParts.push(author);
      if (infoParts.length > 0) {
        novel.info = infoParts.join(' | ');
      }

      const tagList = this.splitTags(tags);
      if (tagList.length > 0) {
        this.collectTags(tagList);
        novel.genres = tagList.join(',');
      }

      novels.push(novel);
    });

    return novels;
  }

  private extractChapterIds(path: string): { aid: string; cid: string } | null {
    const match = path.match(/\/novel\/(\d+)\/(\d+)\.htm/);
    if (!match) return null;
    return { aid: match[1], cid: match[2] };
  }

  private buildAndroidRequestBody(aid: string, cid: string): string {
    const payload = `action=book&do=text&aid=${aid}&cid=${cid}&t=0`;
    return `appver=1.13&request=${encodeURIComponent(btoa(payload))}&timetoken=${Math.floor(Date.now() / 1000)}`;
  }

  private async fetchAndroidChapter(chapterPath: string): Promise<string> {
    const ids = this.extractChapterIds(chapterPath);
    if (!ids) return '';

    const body = await fetchText('http://app.wenku8.com/android.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 7.1.2)',
      },
      body: this.buildAndroidRequestBody(ids.aid, ids.cid),
    });

    if (body === '') return '';

    const imageMatches = Array.from(
      body.matchAll(/https?:\/\/pic\.wenku8\.com\/pictures\/[^\s<>"']+?\.jpg/g),
    ).map(match => match[0]);
    const text = body
      .replace(
        /https?:\/\/pic\.wenku8\.com\/pictures\/[^\s<>"']+?\.jpg(?:\(\d+K\))?/g,
        '',
      )
      .replace(/&nbsp;/g, '')
      .replace(/http:\/\/www\.wenku8\.com/g, '')
      .trim();

    if (!text && imageMatches.length === 0) return '';

    const paragraphs = text
      .split(/\r?\n+/)
      .map(line => this.cleanText(line))
      .filter(Boolean)
      .map(line => `<p>${line}</p>`)
      .join('');

    const images = imageMatches.map(src => `<img src="${src}">`).join('');
    return `${paragraphs}${images}`;
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    this.refreshTagOptions();

    const selectedTag = this.getSelectedTag(filters);
    if (selectedTag) {
      const searched = await this.searchNovels(selectedTag, pageNo);
      return searched.filter(novel =>
        ((novel as NovelListItem).genres || '')
          .split(',')
          .map(tag => tag.trim())
          .includes(selectedTag),
      );
    }

    const sort = showLatestNovels ? 'lastupdate' : filters.sort.value;
    const body = await this.fetchPage(
      `${this.site}/modules/article/toplist.php?sort=${sort}&page=${pageNo}`,
      'gbk',
    );

    if (this.isBlocked(body)) {
      return [
        {
          name: 'Login to Wenku8 in WebView',
          path: '/login.php?jumpurl=http%3A%2F%2Fwww.wenku8.net%2Findex.php',
          cover: defaultCover,
        },
      ];
    }

    return this.parseGridResults(body);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const body = await this.fetchPage(this.makeAbsolute(novelPath), 'gbk');
    if (this.isBlocked(body)) {
      return this.getLoginPromptNovel(novelPath);
    }

    const $ = parseHTML(body);
    const content = $('#content');
    const contentText = this.cleanText(content.text());
    const contentHtml = content.html() || '';

    if (content.find('.blocktitle').first().text().trim() === '出现错误！') {
      throw new Error('Novel not found');
    }

    const title =
      this.cleanText(content.find('span b').first().text()) ||
      this.cleanText($('title').text());
    const cover = this.makeAbsolute(content.find('img').first().attr('src'));
    const author = this.extractField(
      contentText,
      ['小说作者'],
      ['所属文库', '文章状态', '最后更新', '全文长度', '字数', '字數'],
    );
    const library = this.extractField(
      contentText,
      ['所属文库'],
      ['小说作者', '文章状态', '最后更新', '全文长度', '字数', '字數'],
    );
    const statusText = this.extractField(
      contentText,
      ['文章状态'],
      ['最后更新', '全文长度', '字数', '字數'],
    );
    const tags = this.extractField(
      contentText,
      ['Tags', '标签', '標籤'],
      [
        '最新章节',
        '最新章節',
        '内容简介',
        '內容簡介',
        '全文长度',
        '字数',
        '字數',
      ],
    );
    const lengthText = this.extractField(
      contentText,
      ['全文长度', '字数', '字數'],
      ['小说作者', '所属文库', '文章状态', '最后更新'],
    );
    const summary =
      content
        .find('span')
        .map((_i, el) => this.cleanText($(el).text()))
        .toArray()
        .filter(text => text.length > 20)
        .pop() || '';

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: title || 'Untitled',
      cover: cover || defaultCover,
      author,
      summary,
      chapters: [],
    };

    if (statusText.includes('连载') || statusText.includes('連載')) {
      novel.status = NovelStatus.Ongoing;
    } else if (
      statusText.includes('完成') ||
      statusText.includes('完结') ||
      statusText.includes('完結')
    ) {
      novel.status = NovelStatus.Completed;
    }

    const genreParts = Array.from(
      new Set(this.splitTags([library, tags].join(','))),
    );
    if (genreParts.length > 0) {
      this.collectTags(genreParts);
      novel.genres = genreParts.join(',');
    }

    const wordCount = this.parseWordCount(lengthText);
    if (wordCount) {
      novel.wordCount = wordCount;
    }

    const catalogPath =
      contentHtml.match(/<a href="(\/novel\/[^"]+)">小说目录<\/a>/)?.[1] ||
      content.find('a[href*="/novel/"]').last().attr('href');
    if (!catalogPath) {
      return novel;
    }

    const catalogBody = await this.fetchPage(
      this.makeAbsolute(catalogPath),
      'gbk',
    );
    if (this.isBlocked(catalogBody)) {
      return novel;
    }

    const catalog$ = parseHTML(catalogBody);
    const rows = catalog$('tbody').first().children('tr');
    const volumes: { name: string; start: number; end: number }[] = [];

    rows.each((index, el) => {
      const header = catalog$(el).find('td[colspan]').first();
      if (header.length === 0) return;

      volumes.push({
        name: this.cleanText(header.text()),
        start: index,
        end: rows.length,
      });
    });

    for (let index = 0; index < volumes.length; index += 1) {
      const nextVolume = volumes[index + 1];
      if (nextVolume) {
        volumes[index].end = nextVolume.start;
      }
    }

    let chapterNumber = 0;
    volumes.forEach(volume => {
      rows
        .slice(volume.start, volume.end)
        .find('a[href]')
        .each((_i, el) => {
          const link = catalog$(el);
          const href = link.attr('href');
          const chapterTitle = this.cleanText(link.text());
          if (!href || !chapterTitle) return;

          chapterNumber += 1;
          novel.chapters.push({
            name: volume.name ? `${volume.name} ${chapterTitle}` : chapterTitle,
            path: href,
            chapterNumber,
          });
        });
    });

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const body = await this.fetchPage(this.makeAbsolute(chapterPath), 'gbk');

    if (!this.isBlocked(body)) {
      const $ = parseHTML(body);
      const firstSpanText = this.cleanText(
        $('#contentmain span').first().text(),
      );

      if (firstSpanText && firstSpanText !== 'null') {
        const content = $('#content');
        content.find('script').remove();
        content.find('img').each((_i, el) => {
          const src = $(el).attr('src');
          if (src) {
            $(el).attr('src', this.makeAbsolute(src));
          }
        });

        let html = content.html() || '';
        html = html
          .replace(/本文来自\s*轻小说文库\(http:\/\/www\.wenku8\.com\)/g, '')
          .replace(/台版\s*转自\s*轻之国度/g, '')
          .replace(
            /最新最全的日本动漫轻小说\s*轻小说文库\(http:\/\/www\.wenku8\.com\)\s*为你一网打尽！/g,
            '',
          )
          .trim();

        if (html) {
          return html;
        }
      }
    }

    const androidContent = await this.fetchAndroidChapter(chapterPath);
    if (androidContent) {
      return androidContent;
    }

    return '<p style="text-align:center;color:red;font-weight:bold;">Wenku8 content is currently unavailable. Please log in from WebView and try again.</p>';
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    this.refreshTagOptions();

    const searchKey = encode(searchTerm, 'gbk');
    const body = await this.fetchPage(
      `${this.site}/modules/article/search.php?searchtype=articlename&searchkey=${searchKey}&page=${pageNo}`,
      'gbk',
    );

    if (this.isBlocked(body)) {
      return [];
    }

    const novels = this.parseGridResults(body);
    if (novels.length > 0) {
      return novels;
    }

    const $ = parseHTML(body);
    const directPath = $('a[href*="/book/"]').first().attr('href');
    if (!directPath) {
      return [];
    }

    return [
      {
        name:
          this.cleanText($('#content span b').first().text()) ||
          this.cleanText($('title').text()),
        path: directPath,
        cover: this.makeAbsolute($('#content img').first().attr('src')),
      },
    ];
  }

  filters = {
    sort: {
      label: 'Sort',
      value: 'lastupdate',
      options: [
        { label: 'Latest Update', value: 'lastupdate' },
        { label: 'All Visit', value: 'allvisit' },
        { label: 'Month Visit', value: 'monthvisit' },
        { label: 'Week Visit', value: 'weekvisit' },
        { label: 'All Vote', value: 'allvote' },
        { label: 'Month Vote', value: 'monthvote' },
        { label: 'Week Vote', value: 'weekvote' },
      ],
      type: FilterTypes.Picker,
    },
    customTag: {
      label: 'Tag',
      value: [] as string[],
      options: [] as TagOption[],
      maxSelections: 1,
      type: FilterTypes.AutocompleteMulti,
    },
  } satisfies Filters;
}

export default new Wenku8();
