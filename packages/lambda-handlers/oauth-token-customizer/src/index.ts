/**
 * Pre-Token Generation Lambda Trigger for MCP OAuth
 *
 * This Lambda is triggered by Cognito before issuing tokens.
 * It customizes the token claims to add the MCP server audience.
 *
 * Per MCP OAuth 2.1 spec, tokens MUST have audience binding to the
 * specific MCP server they are intended for.
 */

import type {
  PreTokenGenerationTriggerEvent,
  PreTokenGenerationTriggerHandler,
} from 'aws-lambda';

// MCP server URL that should be in the audience claim
const MCP_SERVER_AUDIENCE = process.env.MCP_SERVER_AUDIENCE || 'https://mcp.donate-mate.com';

export const handler: PreTokenGenerationTriggerHandler = async (
  event: PreTokenGenerationTriggerEvent
): Promise<PreTokenGenerationTriggerEvent> => {
  console.info('Pre-token generation trigger', {
    userPoolId: event.userPoolId,
    userName: event.userName,
    triggerSource: event.triggerSource,
  });

  // Add custom claims to the token
  event.response = {
    claimsOverrideDetails: {
      claimsToAddOrOverride: {
        // Add audience claim for MCP server (required by MCP OAuth spec)
        aud: MCP_SERVER_AUDIENCE,
        // Add custom claim to identify this as an MCP OAuth token
        'custom:mcp_access': 'true',
      },
      // Keep the default claims
      claimsToSuppress: [],
    },
  };

  return event;
};
