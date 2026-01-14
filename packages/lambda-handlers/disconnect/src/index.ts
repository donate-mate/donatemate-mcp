/**
 * MCP WebSocket $disconnect Handler
 *
 * Cleans up connection state from DynamoDB when client disconnects.
 */

import { DynamoDBClient, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import type {
  APIGatewayProxyResultV2,
  APIGatewayProxyWebsocketEventV2,
} from 'aws-lambda';

const dynamoClient = new DynamoDBClient({});

export async function handler(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;
  const tableName = process.env.CONNECTIONS_TABLE_NAME;

  if (!tableName) {
    console.error('CONNECTIONS_TABLE_NAME not configured');
    return { statusCode: 500, body: 'Server configuration error' };
  }

  try {
    // Remove connection from DynamoDB
    await dynamoClient.send(
      new DeleteItemCommand({
        TableName: tableName,
        Key: {
          connectionId: { S: connectionId },
        },
      })
    );

    console.info('Connection closed', { connectionId });
    return { statusCode: 200, body: 'Disconnected' };
  } catch (error) {
    console.error('Disconnect cleanup failed', {
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    });

    // Still return success - client is disconnected regardless
    return { statusCode: 200, body: 'Disconnected' };
  }
}
