/// <reference types="@figma/plugin-typings" />

figma.showUI(__html__, { width: 400, height: 500 });

// Design tokens cache
let designTokens: Record<string, any> = {};

// Helper to parse color from hex or rgba
function parseColor(color: string): RGB {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
    };
  }
  if (color.startsWith('rgba') || color.startsWith('rgb')) {
    const match = color.match(/[\d.]+/g);
    if (match) {
      return {
        r: parseInt(match[0]) / 255,
        g: parseInt(match[1]) / 255,
        b: parseInt(match[2]) / 255,
      };
    }
  }
  return { r: 0, g: 0, b: 0 };
}

// Helper to create solid paint
function createSolidPaint(color: string): SolidPaint {
  return {
    type: 'SOLID',
    color: parseColor(color),
  };
}

// Find node by ID
function findNodeById(id: string): BaseNode | null {
  return figma.getNodeById(id);
}

// Safe JSON serialization (handles symbols and circular refs)
function safeSerialize(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return undefined;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(safeSerialize);

  const result: any = {};
  for (const key of Object.keys(value)) {
    try {
      const val = value[key];
      if (typeof val !== 'symbol' && typeof val !== 'function') {
        result[key] = safeSerialize(val);
      }
    } catch {
      // Skip properties that can't be accessed
    }
  }
  return result;
}

// Safe wrapper for postMessage to prevent "Cannot unwrap symbol" errors
function safePostMessage(message: any): void {
  try {
    figma.ui.postMessage(safeSerialize(message));
  } catch (e) {
    // If serialization still fails, send a minimal error message
    figma.ui.postMessage({
      type: 'ERROR',
      message: `Failed to serialize response: ${e instanceof Error ? e.message : 'Unknown error'}`,
      requestId: message?.requestId,
    });
  }
}

// Serialize node for sending to UI
function serializeNode(node: BaseNode, depth: number = 0, maxDepth: number = 2): any {
  const base: any = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  // Helper to safely get property value
  const safeGet = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };

  // Safely access each property to avoid "Cannot unwrap symbol" errors
  if ('x' in node) base.x = safeGet(() => (node as any).x);
  if ('y' in node) base.y = safeGet(() => (node as any).y);
  if ('width' in node) base.width = safeGet(() => (node as any).width);
  if ('height' in node) base.height = safeGet(() => (node as any).height);
  if ('fills' in node) base.fills = safeGet(() => safeSerialize((node as any).fills));
  if ('strokes' in node) base.strokes = safeGet(() => safeSerialize((node as any).strokes));
  if ('strokeWeight' in node) base.strokeWeight = safeGet(() => (node as any).strokeWeight);
  if ('cornerRadius' in node) base.cornerRadius = safeGet(() => (node as any).cornerRadius);
  if ('opacity' in node) base.opacity = safeGet(() => (node as any).opacity);
  if ('visible' in node) base.visible = safeGet(() => (node as any).visible);
  if ('locked' in node) base.locked = safeGet(() => (node as any).locked);
  if ('characters' in node) base.characters = safeGet(() => (node as any).characters);
  if ('fontSize' in node) base.fontSize = safeGet(() => (node as any).fontSize);
  if ('fontName' in node) base.fontName = safeGet(() => safeSerialize((node as any).fontName));
  if ('textAlignHorizontal' in node) base.textAlignHorizontal = safeGet(() => (node as any).textAlignHorizontal);
  if ('textAlignVertical' in node) base.textAlignVertical = safeGet(() => (node as any).textAlignVertical);
  if ('layoutMode' in node) base.layoutMode = safeGet(() => (node as any).layoutMode);
  if ('primaryAxisAlignItems' in node) base.primaryAxisAlignItems = safeGet(() => (node as any).primaryAxisAlignItems);
  if ('counterAxisAlignItems' in node) base.counterAxisAlignItems = safeGet(() => (node as any).counterAxisAlignItems);
  if ('paddingLeft' in node) base.paddingLeft = safeGet(() => (node as any).paddingLeft);
  if ('paddingRight' in node) base.paddingRight = safeGet(() => (node as any).paddingRight);
  if ('paddingTop' in node) base.paddingTop = safeGet(() => (node as any).paddingTop);
  if ('paddingBottom' in node) base.paddingBottom = safeGet(() => (node as any).paddingBottom);
  if ('itemSpacing' in node) base.itemSpacing = safeGet(() => (node as any).itemSpacing);

  // Include children if within depth limit
  if ('children' in node && depth < maxDepth) {
    try {
      base.children = (node as any).children.map((child: BaseNode) => serializeNode(child, depth + 1, maxDepth));
      base.childCount = (node as any).children.length;
    } catch {
      base.childCount = 0;
      base.childrenError = 'Could not access children';
    }
  } else if ('children' in node) {
    try {
      base.childCount = (node as any).children.length;
    } catch {
      base.childCount = 0;
    }
  }

  return base;
}

// Handle incoming messages
figma.ui.onmessage = async (msg: any) => {
  console.log('Plugin received:', msg.type);
  const requestId = msg.requestId;

  try {
    switch (msg.type) {
      case 'PING': {
        safePostMessage({ type: 'PONG', status: 'connected', requestId });
        break;
      }

      case 'GET_DOCUMENT_INFO': {
        const info = {
          name: figma.root.name,
          documentId: figma.root.id,
          currentPage: figma.currentPage.name,
          currentPageId: figma.currentPage.id,
          pages: figma.root.children.map(p => ({ id: p.id, name: p.name })),
          selection: figma.currentPage.selection.map(n => ({
            id: n.id,
            name: n.name,
            type: n.type,
          })),
          // Note: File key is only available from the URL (figma.com/file/FILE_KEY/...)
          // It cannot be accessed from the Plugin API
          fileKeyNote: 'To use REST API features, get the file key from your Figma URL (the string after /file/)',
        };
        safePostMessage({ type: 'DOCUMENT_INFO', data: info, requestId });
        break;
      }

      // ===== Get current file context (for branching workflow) =====
      case 'GET_FILE_CONTEXT': {
        // figma.fileKey is available if running in Figma (may be undefined in some contexts)
        // Branch names typically contain indicators like "[Branch]" or are prefixed
        const fileName = figma.root.name;
        const isBranchIndicator = fileName.includes('[Branch]') || fileName.includes('(Branch)');

        const context = {
          // Architecture info
          architecture: {
            description: 'Figma Desktop is running in an AWS Windows VM with the DonateMate Design Bridge plugin. The plugin connects to a relay agent that bridges to the MCP server via WebSocket.',
            vmLocation: 'AWS EC2 Windows instance (donatemate-staging-figma-vm)',
            pluginName: 'DonateMate Design Bridge',
          },
          // File info
          fileName: fileName,
          fileKey: (figma as any).fileKey || null,  // May be available in newer plugin API
          editorType: figma.editorType,  // 'figma', 'figjam', 'dev'
          documentId: figma.root.id,
          currentPage: figma.currentPage.name,
          pageCount: figma.root.children.length,
          // Branch detection heuristics (since Plugin API doesn't expose this directly)
          branchHints: {
            nameContainsBranchIndicator: isBranchIndicator,
            note: 'To confirm if this is a branch, check the Figma URL or use dm_figma_list_branches with the main file key'
          },
          // Guidance for branching workflow
          workflow: {
            recommendation: 'ALWAYS create a branch before making any design changes. This protects the main file when other designers are working.',
            steps: [
              '1. Copy any Figma link from the file (right-click → Copy link)',
              '2. Use dm_figma_list_branches to check existing branches',
              '3. Use dm_figma_create_branch to create a new branch for MCP changes',
              '4. Open the branch URL in the Figma VM',
              '5. Make changes via MCP tools',
              '6. Review and merge the branch in Figma when ready'
            ]
          },
          // UI state coverage requirements
          designGuidelines: {
            uiStates: 'When updating designs, ALWAYS consider and update ALL relevant UI states where logically applicable.',
            requiredStates: [
              'Empty state - No data entered yet (blank inputs, empty lists)',
              'Filled state - Partial data entered (some fields filled)',
              'Completed state - All fields correctly filled with valid data',
              'Error state - Validation failures, error messages displayed'
            ],
            note: 'Apply changes consistently across all screen variations (e.g., Dashboard - Empty, Dashboard - Actions Pending, Dashboard - Error). Do not update just one state and leave others inconsistent.',
            validation: {
              requirement: 'REQUIRED: After completing design changes, ALWAYS run dm_figma_validate_design to verify consistency.',
              checks: [
                'Design tokens - Colors and fonts match established token definitions',
                'Component consistency - Same component types (Back buttons, Headers, Inputs) use identical styling across all screens',
                'Style uniformity - No one-off colors, fonts, or sizing that deviate from the design system'
              ],
              action: 'Fix any issues flagged by validation before considering design work complete.'
            }
          }
        };

        safePostMessage({ type: 'FILE_CONTEXT', data: context, requestId });
        break;
      }

      case 'GET_SELECTION': {
        const selection = figma.currentPage.selection.map(node => serializeNode(node, 0, 3));
        safePostMessage({ type: 'SELECTION', data: selection, requestId });
        break;
      }

      case 'GET_PAGE': {
        const children = figma.currentPage.children.map(node => serializeNode(node, 0, 1));
        safePostMessage({
          type: 'PAGE_INFO',
          data: {
            id: figma.currentPage.id,
            name: figma.currentPage.name,
            children,
          },
          requestId,
        });
        break;
      }

      // ===== NEW: Set current page =====
      case 'SET_PAGE': {
        const page = figma.root.children.find(p => p.id === msg.pageId || p.name === msg.pageName);
        if (page) {
          figma.currentPage = page as PageNode;
          safePostMessage({
            type: 'PAGE_SET',
            data: { id: page.id, name: page.name },
            requestId,
          });
        } else {
          throw new Error(`Page not found: ${msg.pageId || msg.pageName}`);
        }
        break;
      }

      // ===== NEW: Get comments =====
      case 'GET_COMMENTS': {
        // Note: Figma Plugin API doesn't have direct access to comments
        // Comments are only available via REST API, but we can get reactions
        // For now, return a message indicating this limitation
        safePostMessage({
          type: 'COMMENTS',
          data: {
            note: 'Comments require Figma REST API access. Use the Figma API with your access token to fetch comments.',
            documentId: figma.root.name,
          },
          requestId,
        });
        break;
      }

      // ===== NEW: Get node by ID =====
      case 'GET_NODE': {
        const node = figma.getNodeById(msg.nodeId);
        if (node) {
          safePostMessage({
            type: 'NODE',
            data: serializeNode(node, 0, msg.depth || 3),
            requestId,
          });
        } else {
          throw new Error(`Node not found: ${msg.nodeId}`);
        }
        break;
      }

      // ===== NEW: Get children of a node =====
      case 'GET_CHILDREN': {
        const node = figma.getNodeById(msg.nodeId);
        if (!node) throw new Error(`Node not found: ${msg.nodeId}`);
        if (!('children' in node)) throw new Error(`Node has no children: ${msg.nodeId}`);

        const depth = msg.depth || 1;
        const children = (node as any).children.map((child: BaseNode) => serializeNode(child, 0, depth));

        safePostMessage({
          type: 'CHILDREN',
          data: {
            parentId: msg.nodeId,
            parentName: node.name,
            children,
            count: children.length,
          },
          requestId,
        });
        break;
      }

      // ===== NEW: Get all nodes on page (with optional filtering) =====
      case 'GET_ALL_NODES': {
        const nodes: any[] = [];
        const maxNodes = msg.limit || 500;

        function collectNodes(node: BaseNode) {
          if (nodes.length >= maxNodes) return;

          const matchesType = !msg.nodeType || node.type === msg.nodeType;
          const matchesName = !msg.namePattern || node.name.toLowerCase().includes(msg.namePattern.toLowerCase());

          if (matchesType && matchesName) {
            nodes.push(serializeNode(node, 0, 1));
          }

          if ('children' in node) {
            for (const child of node.children) {
              collectNodes(child);
            }
          }
        }

        collectNodes(figma.currentPage);
        safePostMessage({
          type: 'ALL_NODES',
          data: nodes,
          total: nodes.length,
          requestId,
        });
        break;
      }

      // ===== NEW: Deep search for nodes by text content across all pages =====
      case 'FIND_TEXT_NODES': {
        const searchText = msg.text?.toLowerCase();
        const searchAllPages = msg.allPages !== false;
        const maxResults = msg.limit || 100;
        const results: any[] = [];

        function searchNode(node: BaseNode, pageName: string) {
          if (results.length >= maxResults) return;

          // Check if this is a text node with matching content
          if (node.type === 'TEXT') {
            const textNode = node as TextNode;
            try {
              const chars = textNode.characters?.toLowerCase();
              if (chars && chars.includes(searchText)) {
                results.push({
                  id: node.id,
                  name: node.name,
                  type: node.type,
                  page: pageName,
                  characters: textNode.characters,
                  x: textNode.x,
                  y: textNode.y,
                  // Include parent chain for context
                  parentId: node.parent?.id,
                  parentName: node.parent?.name,
                });
              }
            } catch {
              // Skip nodes we can't access
            }
          }

          // Traverse children (including component instances)
          if ('children' in node) {
            for (const child of (node as any).children) {
              searchNode(child, pageName);
            }
          }
        }

        if (searchAllPages) {
          for (const page of figma.root.children) {
            searchNode(page, page.name);
          }
        } else {
          searchNode(figma.currentPage, figma.currentPage.name);
        }

        safePostMessage({
          type: 'TEXT_NODES_FOUND',
          data: {
            searchText: msg.text,
            results,
            total: results.length,
            searchedAllPages: searchAllPages,
          },
          requestId,
        });
        break;
      }

      // ===== NEW: Find node by REST API ID (handles ID format conversion) =====
      case 'FIND_BY_REST_ID': {
        // REST API IDs use format like "4337:532" or "4337-404"
        // Plugin API uses internal IDs
        const restId = msg.restId;
        let found: BaseNode | null = null;

        // Try direct lookup first (might work for some IDs)
        found = figma.getNodeById(restId);

        // If not found, try with colon instead of dash
        if (!found && restId.includes('-')) {
          const colonId = restId.replace('-', ':');
          found = figma.getNodeById(colonId);
        }

        // If still not found, search all pages for a node containing this ID pattern
        if (!found) {
          const idParts = restId.split(/[-:]/);
          const searchId = idParts[idParts.length - 1]; // Use last part as search

          function searchForId(node: BaseNode): BaseNode | null {
            if (node.id.includes(searchId)) {
              return node;
            }
            if ('children' in node) {
              for (const child of (node as any).children) {
                const result = searchForId(child);
                if (result) return result;
              }
            }
            return null;
          }

          for (const page of figma.root.children) {
            found = searchForId(page);
            if (found) break;
          }
        }

        if (found) {
          safePostMessage({
            type: 'NODE_FOUND',
            data: serializeNode(found, 0, 2),
            requestId,
          });
        } else {
          safePostMessage({
            type: 'NODE_NOT_FOUND',
            data: {
              searchedId: restId,
              suggestion: 'Try using FIND_TEXT_NODES to search by text content instead',
            },
            requestId,
          });
        }
        break;
      }

      // ===== NEW: Update node properties =====
      case 'UPDATE_NODE': {
        const node = figma.getNodeById(msg.nodeId);
        if (!node) throw new Error(`Node not found: ${msg.nodeId}`);

        const props = msg.properties;

        if ('x' in props && 'x' in node) (node as any).x = props.x;
        if ('y' in props && 'y' in node) (node as any).y = props.y;
        if ('width' in props && 'resize' in node) (node as any).resize(props.width, (node as any).height);
        if ('height' in props && 'resize' in node) (node as any).resize((node as any).width, props.height);
        if ('name' in props) node.name = props.name;
        if ('visible' in props && 'visible' in node) (node as any).visible = props.visible;
        if ('locked' in props && 'locked' in node) (node as any).locked = props.locked;
        if ('opacity' in props && 'opacity' in node) (node as any).opacity = props.opacity;
        if ('rotation' in props && 'rotation' in node) (node as any).rotation = props.rotation;

        if ('fills' in props && 'fills' in node) {
          if (typeof props.fills === 'string') {
            (node as any).fills = [createSolidPaint(props.fills)];
          } else {
            (node as any).fills = props.fills;
          }
        }

        if ('strokes' in props && 'strokes' in node) {
          if (typeof props.strokes === 'string') {
            (node as any).strokes = [createSolidPaint(props.strokes)];
          } else {
            (node as any).strokes = props.strokes;
          }
        }

        if ('strokeWeight' in props && 'strokeWeight' in node) (node as any).strokeWeight = props.strokeWeight;
        if ('cornerRadius' in props && 'cornerRadius' in node) (node as any).cornerRadius = props.cornerRadius;

        if ('characters' in props && node.type === 'TEXT') {
          await figma.loadFontAsync((node as TextNode).fontName as FontName);
          (node as TextNode).characters = props.characters;
        }

        if ('fontSize' in props && node.type === 'TEXT') {
          await figma.loadFontAsync((node as TextNode).fontName as FontName);
          (node as TextNode).fontSize = props.fontSize;
        }

        // Auto-layout properties
        if ('layoutMode' in props && 'layoutMode' in node) (node as any).layoutMode = props.layoutMode;
        if ('primaryAxisAlignItems' in props && 'primaryAxisAlignItems' in node) (node as any).primaryAxisAlignItems = props.primaryAxisAlignItems;
        if ('counterAxisAlignItems' in props && 'counterAxisAlignItems' in node) (node as any).counterAxisAlignItems = props.counterAxisAlignItems;
        if ('paddingLeft' in props && 'paddingLeft' in node) (node as any).paddingLeft = props.paddingLeft;
        if ('paddingRight' in props && 'paddingRight' in node) (node as any).paddingRight = props.paddingRight;
        if ('paddingTop' in props && 'paddingTop' in node) (node as any).paddingTop = props.paddingTop;
        if ('paddingBottom' in props && 'paddingBottom' in node) (node as any).paddingBottom = props.paddingBottom;
        if ('itemSpacing' in props && 'itemSpacing' in node) (node as any).itemSpacing = props.itemSpacing;

        safePostMessage({
          type: 'NODE_UPDATED',
          data: serializeNode(node),
          requestId,
        });
        break;
      }

      // ===== NEW: Delete node =====
      case 'DELETE_NODE': {
        const node = figma.getNodeById(msg.nodeId);
        if (!node) throw new Error(`Node not found: ${msg.nodeId}`);
        const nodeName = node.name;
        node.remove();
        safePostMessage({
          type: 'NODE_DELETED',
          data: { id: msg.nodeId, name: nodeName },
          requestId,
        });
        break;
      }

      // ===== NEW: Clone/duplicate node =====
      case 'CLONE_NODE': {
        const node = figma.getNodeById(msg.nodeId);
        if (!node) throw new Error(`Node not found: ${msg.nodeId}`);
        if (!('clone' in node)) throw new Error(`Node cannot be cloned: ${node.type}`);

        const clone = (node as any).clone();
        if (msg.x !== undefined) clone.x = msg.x;
        if (msg.y !== undefined) clone.y = msg.y;
        if (msg.name) clone.name = msg.name;

        // If parentId specified, reparent the clone into that frame
        if (msg.parentId) {
          const targetParent = figma.getNodeById(msg.parentId);
          if (targetParent && 'appendChild' in targetParent) {
            (targetParent as any).appendChild(clone);
            // Position relative to new parent if coordinates specified
            if (msg.x !== undefined) clone.x = msg.x;
            if (msg.y !== undefined) clone.y = msg.y;
          }
        }

        safePostMessage({
          type: 'NODE_CLONED',
          data: serializeNode(clone),
          requestId,
        });
        break;
      }

      // ===== NEW: Move node to parent =====
      case 'MOVE_NODE': {
        const node = figma.getNodeById(msg.nodeId);
        if (!node) throw new Error(`Node not found: ${msg.nodeId}`);

        const parent = msg.parentId ? figma.getNodeById(msg.parentId) : figma.currentPage;
        if (!parent || !('appendChild' in parent)) throw new Error(`Invalid parent: ${msg.parentId}`);

        (parent as any).appendChild(node);

        if (msg.index !== undefined && 'insertChild' in parent) {
          const children = (parent as any).children;
          const currentIndex = children.indexOf(node);
          if (currentIndex !== msg.index) {
            (parent as any).insertChild(msg.index, node);
          }
        }

        safePostMessage({
          type: 'NODE_MOVED',
          data: { nodeId: msg.nodeId, newParentId: parent.id },
          requestId,
        });
        break;
      }

      // ===== NEW: Group nodes =====
      case 'GROUP_NODES': {
        const nodes = msg.nodeIds.map((id: string) => figma.getNodeById(id)).filter(Boolean) as SceneNode[];
        if (nodes.length === 0) throw new Error('No valid nodes to group');

        const group = figma.group(nodes, figma.currentPage);
        if (msg.name) group.name = msg.name;

        safePostMessage({
          type: 'NODES_GROUPED',
          data: serializeNode(group),
          requestId,
        });
        break;
      }

      // ===== NEW: Ungroup nodes =====
      case 'UNGROUP_NODES': {
        const node = figma.getNodeById(msg.nodeId);
        if (!node || node.type !== 'GROUP') throw new Error(`Not a group: ${msg.nodeId}`);

        const group = node as GroupNode;
        const parent = group.parent;
        const children = [...group.children];

        for (const child of children) {
          if (parent && 'appendChild' in parent) {
            (parent as any).appendChild(child);
          }
        }
        group.remove();

        safePostMessage({
          type: 'NODES_UNGROUPED',
          data: { originalGroupId: msg.nodeId, childIds: children.map(c => c.id) },
          requestId,
        });
        break;
      }

      // ===== NEW: Set selection =====
      case 'SET_SELECTION': {
        const nodes = msg.nodeIds.map((id: string) => figma.getNodeById(id)).filter(Boolean) as SceneNode[];
        figma.currentPage.selection = nodes;
        safePostMessage({
          type: 'SELECTION_SET',
          data: nodes.map(n => ({ id: n.id, name: n.name })),
          requestId,
        });
        break;
      }

      // ===== NEW: Zoom to node =====
      case 'ZOOM_TO_NODE': {
        const node = figma.getNodeById(msg.nodeId);
        if (!node) throw new Error(`Node not found: ${msg.nodeId}`);
        figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
        safePostMessage({
          type: 'ZOOMED',
          data: { nodeId: msg.nodeId },
          requestId,
        });
        break;
      }

      // ===== NEW: Get local styles =====
      case 'GET_STYLES': {
        const paintStyles = figma.getLocalPaintStyles().map(s => ({
          id: s.id,
          name: s.name,
          type: 'PAINT',
          paints: s.paints,
        }));
        const textStyles = figma.getLocalTextStyles().map(s => ({
          id: s.id,
          name: s.name,
          type: 'TEXT',
          fontSize: s.fontSize,
          fontName: s.fontName,
          lineHeight: s.lineHeight,
          letterSpacing: s.letterSpacing,
        }));
        const effectStyles = figma.getLocalEffectStyles().map(s => ({
          id: s.id,
          name: s.name,
          type: 'EFFECT',
          effects: s.effects,
        }));

        safePostMessage({
          type: 'STYLES',
          data: { paintStyles, textStyles, effectStyles },
          requestId,
        });
        break;
      }

      // ===== NEW: Get local variables =====
      case 'GET_VARIABLES': {
        const collections = figma.variables.getLocalVariableCollections();
        const data = collections.map(collection => ({
          id: collection.id,
          name: collection.name,
          modes: collection.modes,
          variables: collection.variableIds.map(varId => {
            const variable = figma.variables.getVariableById(varId);
            return variable ? {
              id: variable.id,
              name: variable.name,
              resolvedType: variable.resolvedType,
              valuesByMode: variable.valuesByMode,
            } : null;
          }).filter(Boolean),
        }));

        safePostMessage({
          type: 'VARIABLES',
          data,
          requestId,
        });
        break;
      }

      // ===== NEW: Export node as image =====
      case 'EXPORT_NODE': {
        const node = figma.getNodeById(msg.nodeId);
        if (!node) throw new Error(`Node not found: ${msg.nodeId}`);
        if (!('exportAsync' in node)) throw new Error(`Node cannot be exported: ${node.type}`);

        const format = msg.format || 'PNG';
        const scale = msg.scale || 2;

        const bytes = await (node as any).exportAsync({
          format,
          constraint: { type: 'SCALE', value: scale },
        });

        // Convert to base64
        const base64 = figma.base64Encode(bytes);

        safePostMessage({
          type: 'EXPORTED',
          data: {
            nodeId: msg.nodeId,
            format,
            scale,
            base64,
            size: bytes.length,
          },
          requestId,
        });
        break;
      }

      // ===== NEW: Create ellipse =====
      case 'CREATE_ELLIPSE': {
        const ellipse = figma.createEllipse();
        ellipse.name = msg.name || 'Ellipse';
        ellipse.x = msg.x || 0;
        ellipse.y = msg.y || 0;
        ellipse.resize(msg.width || 100, msg.height || 100);

        if (msg.fills) {
          ellipse.fills = typeof msg.fills === 'string' ? [createSolidPaint(msg.fills)] : msg.fills;
        }
        if (msg.strokes) {
          ellipse.strokes = typeof msg.strokes === 'string' ? [createSolidPaint(msg.strokes)] : msg.strokes;
        }
        if (msg.strokeWeight) ellipse.strokeWeight = msg.strokeWeight;

        if (msg.parentId) {
          const parent = findNodeById(msg.parentId);
          if (parent && 'appendChild' in parent) (parent as any).appendChild(ellipse);
        } else {
          figma.currentPage.appendChild(ellipse);
        }

        safePostMessage({
          type: 'CREATED',
          nodeType: 'ELLIPSE',
          id: ellipse.id,
          requestId,
        });
        break;
      }

      // ===== NEW: Create line =====
      case 'CREATE_LINE': {
        const line = figma.createLine();
        line.name = msg.name || 'Line';
        line.x = msg.x || 0;
        line.y = msg.y || 0;
        line.resize(msg.length || 100, 0);
        if (msg.rotation) line.rotation = msg.rotation;

        if (msg.strokes) {
          line.strokes = typeof msg.strokes === 'string' ? [createSolidPaint(msg.strokes)] : msg.strokes;
        }
        if (msg.strokeWeight) line.strokeWeight = msg.strokeWeight;

        if (msg.parentId) {
          const parent = findNodeById(msg.parentId);
          if (parent && 'appendChild' in parent) (parent as any).appendChild(line);
        } else {
          figma.currentPage.appendChild(line);
        }

        safePostMessage({
          type: 'CREATED',
          nodeType: 'LINE',
          id: line.id,
          requestId,
        });
        break;
      }

      // ===== NEW: Create auto-layout frame =====
      case 'CREATE_AUTO_LAYOUT': {
        const frame = figma.createFrame();
        frame.name = msg.name || 'Auto Layout';
        frame.layoutMode = msg.direction === 'HORIZONTAL' ? 'HORIZONTAL' : 'VERTICAL';
        frame.primaryAxisAlignItems = msg.primaryAxisAlign || 'MIN';
        frame.counterAxisAlignItems = msg.counterAxisAlign || 'MIN';
        frame.paddingLeft = msg.paddingLeft ?? msg.padding ?? 0;
        frame.paddingRight = msg.paddingRight ?? msg.padding ?? 0;
        frame.paddingTop = msg.paddingTop ?? msg.padding ?? 0;
        frame.paddingBottom = msg.paddingBottom ?? msg.padding ?? 0;
        frame.itemSpacing = msg.itemSpacing ?? 0;
        frame.x = msg.x || 0;
        frame.y = msg.y || 0;

        if (msg.width && msg.height) {
          frame.resize(msg.width, msg.height);
        }

        if (msg.fills) {
          frame.fills = typeof msg.fills === 'string' ? [createSolidPaint(msg.fills)] : msg.fills;
        }

        if (msg.cornerRadius) frame.cornerRadius = msg.cornerRadius;

        if (msg.parentId) {
          const parent = findNodeById(msg.parentId);
          if (parent && 'appendChild' in parent) (parent as any).appendChild(frame);
        } else {
          figma.currentPage.appendChild(frame);
        }

        safePostMessage({
          type: 'CREATED',
          nodeType: 'AUTO_LAYOUT',
          id: frame.id,
          requestId,
        });
        break;
      }

      // ===== Existing: Create frame =====
      case 'CREATE_FRAME': {
        const frame = figma.createFrame();
        frame.name = msg.name;
        frame.resize(msg.width, msg.height);
        frame.x = msg.x ?? 0;
        frame.y = msg.y ?? 0;
        if (msg.fills) {
          frame.fills = msg.fills;
        }
        figma.currentPage.appendChild(frame);
        figma.currentPage.selection = [frame];
        figma.viewport.scrollAndZoomIntoView([frame]);
        safePostMessage({
          type: 'CREATED',
          nodeType: 'FRAME',
          id: frame.id,
          name: frame.name,
          requestId,
        });
        break;
      }

      case 'CREATE_TEXT': {
        const text = figma.createText();
        await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });

        try {
          await figma.loadFontAsync({ family: 'DM Sans', style: 'Regular' });
          text.fontName = { family: 'DM Sans', style: 'Regular' };
        } catch {
          text.fontName = { family: 'Inter', style: 'Regular' };
        }

        // Support both 'characters' (from HTTP handler) and 'content' (legacy)
        text.characters = msg.characters || msg.content || '';
        text.x = msg.x;
        text.y = msg.y;

        if (msg.fontSize) text.fontSize = msg.fontSize;
        if (msg.color) {
          text.fills = [{ type: 'SOLID', color: msg.color }];
        }
        if (msg.width) {
          text.resize(msg.width, text.height);
          text.textAutoResize = 'HEIGHT';
        }

        if (msg.parentId) {
          const parent = findNodeById(msg.parentId);
          if (parent && 'appendChild' in parent) (parent as any).appendChild(text);
        } else {
          figma.currentPage.appendChild(text);
        }

        safePostMessage({
          type: 'CREATED',
          nodeType: 'TEXT',
          id: text.id,
          requestId,
        });
        break;
      }

      case 'CREATE_RECTANGLE': {
        const rect = figma.createRectangle();
        rect.name = msg.name || 'Rectangle';
        rect.x = msg.x;
        rect.y = msg.y;
        rect.resize(msg.width, msg.height);

        if (msg.cornerRadius) rect.cornerRadius = msg.cornerRadius;
        if (msg.fills) rect.fills = msg.fills;
        if (msg.strokes) rect.strokes = msg.strokes;
        if (msg.strokeWeight) rect.strokeWeight = msg.strokeWeight;

        if (msg.parentId) {
          const parent = findNodeById(msg.parentId);
          if (parent && 'appendChild' in parent) (parent as any).appendChild(rect);
        } else {
          figma.currentPage.appendChild(rect);
        }

        safePostMessage({
          type: 'CREATED',
          nodeType: 'RECTANGLE',
          id: rect.id,
          requestId,
        });
        break;
      }

      case 'CREATE_COMPONENT': {
        const component = figma.createComponent();
        component.name = msg.name;
        component.resize(msg.width, msg.height);
        figma.currentPage.appendChild(component);
        figma.currentPage.selection = [component];
        safePostMessage({
          type: 'CREATED',
          nodeType: 'COMPONENT',
          id: component.id,
          requestId,
        });
        break;
      }

      case 'APPLY_TOKENS': {
        designTokens = msg.tokens;
        safePostMessage({
          type: 'TOKENS_APPLIED',
          count: Object.keys(designTokens).length,
          requestId,
        });
        break;
      }

      case 'CREATE_SCREEN': {
        const { spec } = msg;
        const screen = figma.createFrame();
        screen.name = spec.name;
        screen.resize(spec.width, spec.height);
        screen.fills = [createSolidPaint(spec.background)];

        const createElement = async (el: any, parent: FrameNode | GroupNode) => {
          switch (el.type) {
            case 'frame': {
              const frame = figma.createFrame();
              frame.name = el.name || 'Frame';
              frame.x = el.x;
              frame.y = el.y;
              if (el.width && el.height) frame.resize(el.width, el.height);
              if (el.properties.background) frame.fills = [createSolidPaint(el.properties.background)];
              if (el.properties.cornerRadius) frame.cornerRadius = el.properties.cornerRadius;
              parent.appendChild(frame);
              if (el.children) {
                for (const child of el.children) await createElement(child, frame);
              }
              break;
            }
            case 'text': {
              const text = figma.createText();
              try {
                await figma.loadFontAsync({ family: 'DM Sans', style: 'Regular' });
                text.fontName = { family: 'DM Sans', style: 'Regular' };
              } catch {
                await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
              }
              text.characters = el.properties.content || '';
              text.x = el.x;
              text.y = el.y;
              if (el.properties.fontSize) text.fontSize = el.properties.fontSize;
              if (el.properties.color) text.fills = [createSolidPaint(el.properties.color)];
              parent.appendChild(text);
              break;
            }
            case 'rectangle':
            case 'button':
            case 'input': {
              const rect = figma.createFrame();
              rect.name = el.name || el.type;
              rect.x = el.x;
              rect.y = el.y;
              if (el.width && el.height) rect.resize(el.width, el.height);
              if (el.properties.background) rect.fills = [createSolidPaint(el.properties.background)];
              if (el.properties.cornerRadius) rect.cornerRadius = el.properties.cornerRadius;
              if (el.properties.borderColor) {
                rect.strokes = [createSolidPaint(el.properties.borderColor)];
                rect.strokeWeight = el.properties.borderWidth || 1;
              }
              parent.appendChild(rect);
              if (el.type === 'button' && el.properties.label) {
                const label = figma.createText();
                try {
                  await figma.loadFontAsync({ family: 'DM Sans', style: 'Medium' });
                  label.fontName = { family: 'DM Sans', style: 'Medium' };
                } catch {
                  await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
                }
                label.characters = el.properties.label;
                label.fontSize = el.properties.fontSize || 16;
                if (el.properties.textColor) label.fills = [createSolidPaint(el.properties.textColor)];
                rect.appendChild(label);
                label.x = (rect.width - label.width) / 2;
                label.y = (rect.height - label.height) / 2;
              }
              break;
            }
          }
        };

        for (const element of spec.elements) {
          await createElement(element, screen);
        }

        figma.currentPage.appendChild(screen);
        figma.currentPage.selection = [screen];
        figma.viewport.scrollAndZoomIntoView([screen]);

        safePostMessage({
          type: 'SCREEN_CREATED',
          id: screen.id,
          name: screen.name,
          requestId,
        });
        break;
      }

      // ===== Validate design consistency =====
      case 'VALIDATE_DESIGN': {
        const checkTokens = msg.checkTokens !== false;
        const checkComponents = msg.checkComponents !== false;
        const componentPatterns = msg.componentPatterns || ['Back', 'Button', 'Header', 'Input', 'Card', 'Nav'];

        const issues: any[] = [];
        const stats = {
          nodesChecked: 0,
          colorsFound: new Map<string, string[]>(),
          fontsFound: new Map<string, string[]>(),
          componentsByPattern: new Map<string, any[]>(),
        };

        // Known design tokens (these should match your token definitions)
        const knownColors = new Set([
          '#3dbafe', '#0ea5e9', '#38bdf8', // sky/primary
          '#1a1a2e', '#374151', '#6b7280', '#9ca3af', // grays/text
          '#ffffff', '#f9fafb', '#f3f4f6', '#e5e7eb', // backgrounds
          '#ef4444', '#dc2626', '#f87171', // error/red
          '#22c55e', '#16a34a', '#4ade80', // success/green
          '#f59e0b', '#fbbf24', // warning/amber
        ]);

        const knownFonts = new Set(['DM Sans', 'Inter', 'SF Pro', 'SF Pro Display', 'SF Pro Text']);

        function rgbToHex(r: number, g: number, b: number): string {
          const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
          return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
        }

        function checkNode(node: BaseNode, path: string = '') {
          stats.nodesChecked++;
          const nodePath = path ? `${path} > ${node.name}` : node.name;

          // Check colors (fills)
          if (checkTokens && 'fills' in node && Array.isArray(node.fills)) {
            for (const fill of node.fills as Paint[]) {
              if (fill.type === 'SOLID' && fill.visible !== false) {
                const hex = rgbToHex(fill.color.r, fill.color.g, fill.color.b).toLowerCase();
                if (!stats.colorsFound.has(hex)) {
                  stats.colorsFound.set(hex, []);
                }
                stats.colorsFound.get(hex)!.push(nodePath);

                if (!knownColors.has(hex)) {
                  issues.push({
                    type: 'unknown_color',
                    severity: 'warning',
                    color: hex,
                    node: nodePath,
                    nodeId: node.id,
                    message: `Color ${hex} is not a known design token`,
                  });
                }
              }
            }
          }

          // Check fonts
          if (checkTokens && 'fontName' in node && node.fontName && typeof node.fontName === 'object') {
            const fontFamily = (node.fontName as FontName).family;
            if (!stats.fontsFound.has(fontFamily)) {
              stats.fontsFound.set(fontFamily, []);
            }
            stats.fontsFound.get(fontFamily)!.push(nodePath);

            if (!knownFonts.has(fontFamily)) {
              issues.push({
                type: 'unknown_font',
                severity: 'warning',
                font: fontFamily,
                node: nodePath,
                nodeId: node.id,
                message: `Font "${fontFamily}" is not a known design token font`,
              });
            }
          }

          // Track components by pattern for consistency checking
          if (checkComponents) {
            for (const pattern of componentPatterns) {
              if (node.name.toLowerCase().includes(pattern.toLowerCase())) {
                if (!stats.componentsByPattern.has(pattern)) {
                  stats.componentsByPattern.set(pattern, []);
                }
                stats.componentsByPattern.get(pattern)!.push({
                  id: node.id,
                  name: node.name,
                  type: node.type,
                  path: nodePath,
                  fills: 'fills' in node ? safeSerialize(node.fills) : undefined,
                  width: 'width' in node ? node.width : undefined,
                  height: 'height' in node ? node.height : undefined,
                  cornerRadius: 'cornerRadius' in node ? node.cornerRadius : undefined,
                });
                break;
              }
            }
          }

          // Recurse into children
          if ('children' in node) {
            for (const child of node.children) {
              checkNode(child, nodePath);
            }
          }
        }

        // Validate specified nodes or current page
        if (msg.nodeIds && msg.nodeIds.length > 0) {
          for (const nodeId of msg.nodeIds) {
            const node = figma.getNodeById(nodeId);
            if (node) checkNode(node);
          }
        } else {
          checkNode(figma.currentPage);
        }

        // Check component consistency
        if (checkComponents) {
          for (const [pattern, components] of stats.componentsByPattern) {
            if (components.length > 1) {
              // Compare components to find inconsistencies
              const first = components[0];
              for (let i = 1; i < components.length; i++) {
                const comp = components[i];
                const differences: string[] = [];

                // Check fill color consistency
                if (JSON.stringify(first.fills) !== JSON.stringify(comp.fills)) {
                  differences.push('fill colors differ');
                }
                // Check size consistency (with tolerance)
                if (first.width && comp.width && Math.abs(first.width - comp.width) > 2) {
                  differences.push(`width differs (${first.width} vs ${comp.width})`);
                }
                if (first.height && comp.height && Math.abs(first.height - comp.height) > 2) {
                  differences.push(`height differs (${first.height} vs ${comp.height})`);
                }
                if (first.cornerRadius !== comp.cornerRadius) {
                  differences.push('corner radius differs');
                }

                if (differences.length > 0) {
                  issues.push({
                    type: 'component_inconsistency',
                    severity: 'error',
                    pattern: pattern,
                    message: `"${comp.name}" differs from "${first.name}": ${differences.join(', ')}`,
                    nodeId: comp.id,
                    referenceNodeId: first.id,
                    differences,
                  });
                }
              }
            }
          }
        }

        // Build summary
        const summary = {
          valid: issues.filter(i => i.severity === 'error').length === 0,
          nodesChecked: stats.nodesChecked,
          issueCount: issues.length,
          errorCount: issues.filter(i => i.severity === 'error').length,
          warningCount: issues.filter(i => i.severity === 'warning').length,
          colorsUsed: Array.from(stats.colorsFound.keys()),
          fontsUsed: Array.from(stats.fontsFound.keys()),
          componentPatternCounts: Object.fromEntries(
            Array.from(stats.componentsByPattern.entries()).map(([k, v]) => [k, v.length])
          ),
        };

        safePostMessage({
          type: 'VALIDATION_RESULT',
          data: {
            summary,
            issues,
            recommendation: issues.length === 0
              ? 'Design validation passed. All tokens and components are consistent.'
              : `Found ${issues.length} issue(s). Please review and fix inconsistencies before finalizing.`,
          },
          requestId,
        });
        break;
      }

      default:
        safePostMessage({
          type: 'ERROR',
          message: `Unknown message type: ${msg.type}`,
          requestId,
        });
    }
  } catch (error) {
    console.error('Plugin error:', error);
    safePostMessage({
      type: 'ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
      requestId,
    });
  }
};

// Notify UI that plugin is ready
safePostMessage({ type: 'READY' });
