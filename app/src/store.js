// Where data is kept.
//
// On AWS (TABLE_NAME is set) everything lives in one DynamoDB table.
// On your laptop (no TABLE_NAME) it lives in a JSON file, so you can
// run and demo the whole app without an AWS account.
//
// There are a few "kinds" of record. Each has its own id:
//   SUPPLY   an apartment's listing of spare treated water
//   REQUEST  a construction site's request for water
//   REPORT   what the AI read from an uploaded lab report
//   COUNTER  how many reports were read today (a spending cap)

import fs from 'node:fs/promises';
import path from 'node:path';

// ---------- DynamoDB (AWS) ----------
async function dynamoStore(tableName) {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand, QueryCommand } = await import(
    '@aws-sdk/lib-dynamodb'
  );

  const options = {};
  if (process.env.DYNAMODB_ENDPOINT) options.endpoint = process.env.DYNAMODB_ENDPOINT; // tests only
  const db = DynamoDBDocumentClient.from(new DynamoDBClient(options), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const strip = ({ pk, sk, ...item }) => item;

  return {
    async put(kind, item) {
      await db.send(new PutCommand({ TableName: tableName, Item: { pk: kind, sk: item.id, ...item } }));
    },
    async get(kind, id) {
      const out = await db.send(new GetCommand({ TableName: tableName, Key: { pk: kind, sk: id } }));
      return out.Item ? strip(out.Item) : null;
    },
    async remove(kind, id) {
      await db.send(new DeleteCommand({ TableName: tableName, Key: { pk: kind, sk: id } }));
    },
    async list(kind) {
      const items = [];
      let startKey;
      do {
        const page = await db.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': kind },
            ExclusiveStartKey: startKey,
          })
        );
        for (const item of page.Items ?? []) items.push(strip(item));
        startKey = page.LastEvaluatedKey;
      } while (startKey);
      return items;
    },
  };
}

// ---------- JSON file (local) ----------
function localStore(dir) {
  const file = path.join(dir, 'db.json');
  const read = async () => {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const write = async (all) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(all, null, 2));
  };
  return {
    async put(kind, item) {
      const all = await read();
      all[kind] = { ...all[kind], [item.id]: item };
      await write(all);
    },
    async get(kind, id) {
      return (await read())[kind]?.[id] ?? null;
    },
    async remove(kind, id) {
      const all = await read();
      if (all[kind]) delete all[kind][id];
      await write(all);
    },
    async list(kind) {
      return Object.values((await read())[kind] ?? {});
    },
  };
}

let cached;
export function getStore() {
  if (!cached) {
    cached = process.env.TABLE_NAME
      ? dynamoStore(process.env.TABLE_NAME)
      : Promise.resolve(localStore(process.env.LOCAL_DATA_DIR || '.local'));
  }
  return cached;
}
