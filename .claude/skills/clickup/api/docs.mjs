/**
 * ClickUp Docs API methods (v3)
 *
 * NOTE: Unlike the Comments API (v2) which uses a proprietary JSON array format
 * (see lib/markdown.mjs for markdownToClickUp conversion), the Docs API (v3)
 * accepts and returns markdown content directly.
 *
 * Content handling:
 * - GET requests: Use Accept header (text/md or text/plain) to specify format
 * - POST/PUT requests: JSON body with `content` field containing markdown string
 *
 * This means we DON'T need the markdownToClickUp() conversion for docs - the API
 * handles markdown natively.
 */

import { apiRequestV3 } from './client.mjs';

/**
 * Search docs in a workspace
 * @param {string} workspaceId - The workspace ID
 * @param {object} options - Search options
 * @param {string} options.query - Search query string
 * @returns {Promise<object[]>} - Array of doc metadata
 */
export async function searchDocs(workspaceId, options = {}) {
  const params = new URLSearchParams();
  if (options.query) params.set('query', options.query);
  if (options.includeArchived) params.set('include_archived', 'true');
  if (options.limit) params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);

  const queryString = params.toString();
  const endpoint = `/workspaces/${workspaceId}/docs${queryString ? `?${queryString}` : ''}`;
  const response = await apiRequestV3(endpoint);

  let docs = response.docs || [];

  // Client-side parent filtering (API doesn't support parent_type/parent_id natively)
  if (options.parentType !== undefined && options.parentId) {
    docs = docs.filter(d =>
      d.parent && d.parent.type === options.parentType && d.parent.id === options.parentId
    );
  }

  return {
    docs,
    nextCursor: response.next_cursor || null,
  };
}

/**
 * Get a doc by ID
 * @param {string} workspaceId - The workspace ID
 * @param {string} docId - The doc ID
 * @returns {Promise<object>} - Doc metadata
 */
export async function getDoc(workspaceId, docId) {
  const response = await apiRequestV3(`/workspaces/${workspaceId}/docs/${docId}`);
  return response;
}

/**
 * Create a new doc
 * @param {string} workspaceId - The workspace ID
 * @param {string} name - The doc name
 * @param {object} options - Additional options
 * @param {string} options.content - Initial content for the first page (markdown)
 * @param {object} options.parent - Parent: { id: string, type: number }
 *   type values: 4=Space, 5=Folder, 6=List, 7/12=Workspace level
 * @param {string} options.visibility - "PUBLIC", "PRIVATE", "PERSONAL", or "HIDDEN"
 * @param {boolean} options.createPage - Auto-create first page (default: true)
 */
export async function createDoc(workspaceId, name, options = {}) {
  const body = { name };
  if (options.parent) body.parent = options.parent;
  if (options.visibility) body.visibility = options.visibility;
  if (options.createPage !== undefined) body.create_page = options.createPage;

  const response = await apiRequestV3(`/workspaces/${workspaceId}/docs`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  // If content was provided, edit the first page that ClickUp auto-creates
  if (options.content && response.id) {
    const pages = await getDocPageListing(workspaceId, response.id);
    if (pages.length > 0) {
      const firstPageId = pages[0].id;
      await editPage(workspaceId, response.id, firstPageId, { content: options.content });
      response.firstPageId = firstPageId;
    }
  }

  return response;
}

/**
 * Get doc page listing (metadata for all pages)
 * @param {string} workspaceId - The workspace ID
 * @param {string} docId - The doc ID
 * @returns {Promise<object[]>} - Array of page metadata
 */
export async function getDocPageListing(workspaceId, docId) {
  const response = await apiRequestV3(`/workspaces/${workspaceId}/docs/${docId}/page_listing`);
  // API returns flat array directly, not wrapped in { pages: [...] }
  return Array.isArray(response) ? response : (response.pages || []);
}

/**
 * Get a specific page content
 * @param {string} workspaceId - The workspace ID
 * @param {string} docId - The doc ID
 * @param {string} pageId - The page ID
 * @param {string} contentFormat - Content format: 'text/md' or 'text/plain'
 * @returns {Promise<object>} - Page with content
 */
export async function getPage(workspaceId, docId, pageId, contentFormat = 'text/md') {
  const params = new URLSearchParams();
  params.set('content_format', contentFormat);
  const response = await apiRequestV3(
    `/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}?${params.toString()}`
  );
  return response;
}

/**
 * Create a new page in a doc
 * @param {string} workspaceId - The workspace ID
 * @param {string} docId - The doc ID
 * @param {string} name - The page name
 * @param {object} options - Additional options
 * @param {string} options.content - Page content in markdown
 * @param {string} options.parentPageId - Parent page ID for subpages
 * @param {string} options.subTitle - Page subtitle
 * @returns {Promise<object>} - Created page
 */
export async function createPage(workspaceId, docId, name, options = {}) {
  const body = { name };
  if (options.content) body.content = options.content;
  if (options.parentPageId) body.parent_page_id = options.parentPageId;
  if (options.subTitle) body.sub_title = options.subTitle;
  if (options.contentFormat) body.content_format = options.contentFormat;
  if (options.orderindex !== undefined) body.orderindex = options.orderindex;

  const response = await apiRequestV3(`/workspaces/${workspaceId}/docs/${docId}/pages`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return response;
}

/**
 * Edit a page's content
 * @param {string} workspaceId - The workspace ID
 * @param {string} docId - The doc ID
 * @param {string} pageId - The page ID
 * @param {object} updates - Updates to apply
 * @param {string} updates.name - New page name
 * @param {string} updates.content - New page content in markdown
 * @param {string} updates.subTitle - New page subtitle
 * @returns {Promise<object>} - Updated page
 */
export async function editPage(workspaceId, docId, pageId, updates) {
  const body = {};
  if (updates.name !== undefined) body.name = updates.name;
  if (updates.content !== undefined) body.content = updates.content;
  if (updates.subTitle !== undefined) body.sub_title = updates.subTitle;
  if (updates.contentEditMode !== undefined) body.content_edit_mode = updates.contentEditMode;
  if (updates.contentFormat !== undefined) body.content_format = updates.contentFormat;
  if (updates.archived !== undefined) body.archived = updates.archived;

  const response = await apiRequestV3(`/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return response;
}
