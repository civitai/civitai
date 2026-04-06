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
  if (options.query) {
    params.set('query', options.query);
  }
  const queryString = params.toString();
  const endpoint = `/workspaces/${workspaceId}/docs${queryString ? `?${queryString}` : ''}`;
  const response = await apiRequestV3(endpoint);
  return response.docs || [];
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
 * @param {string} options.parent - Parent object (e.g., { id: "folderId", type: 6 })
 * @param {string} options.visibility - Doc visibility
 * @returns {Promise<object>} - Created doc (with firstPageId if content was set)
 */
export async function createDoc(workspaceId, name, options = {}) {
  const body = { name };
  if (options.parent) {
    body.parent = options.parent;
  }
  if (options.visibility) {
    body.visibility = options.visibility;
  }

  const response = await apiRequestV3(`/workspaces/${workspaceId}/docs`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  // If content was provided, we need to edit the first page that ClickUp auto-creates
  // (Creating a new page would add a second page, not populate the first one)
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
  const response = await apiRequestV3(`/workspaces/${workspaceId}/docs/${docId}/pageListing`);
  return response.pages || [];
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
  const response = await apiRequestV3(`/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}`, {
    headers: {
      'Accept': contentFormat,
    },
  });
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
  if (options.content) {
    body.content = options.content;
  }
  if (options.parentPageId) {
    body.parent_page_id = options.parentPageId;
  }
  if (options.subTitle) {
    body.sub_title = options.subTitle;
  }

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
  if (updates.name !== undefined) {
    body.name = updates.name;
  }
  if (updates.content !== undefined) {
    body.content = updates.content;
  }
  if (updates.subTitle !== undefined) {
    body.sub_title = updates.subTitle;
  }

  const response = await apiRequestV3(`/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return response;
}
