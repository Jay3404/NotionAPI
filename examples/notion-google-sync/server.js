require("dotenv").config()
const express = require("express")
const app = express()

const { Client } = require("@notionhq/client")
const notion = new Client({ auth: process.env.NOTION_KEY })
const databaseId = process.env.NOTION_DATABASE_ID;

/**
 * Local map to store task pageId to its last status.
 * { [pageId: string]: string }
 */
const taskPageIdToStatusMap = {};

/**
 * Initialize local data store.
 * Then poll for changes every 10 seconds (10000 milliseconds).
 */
setInitialTaskPageIdToStatusMap().then(() => {
  setInterval(findAndProcessUpdatedTasks, 10000);
});

/**
 * Get and set the initial data store with tasks currently in the database.
 */
async function setInitialTaskPageIdToStatusMap() {
  const currentTasks = await getTasksFromNotionDatabase();
  for (const { pageId, status } of currentTasks) {
    taskPageIdToStatusMap[pageId] = status;
  }
}

async function findAndProcessUpdatedTasks() {
  // Get the tasks currently in the database.
  console.log("\nFetching tasks from Notion DB...");
  const currentTasks = await getTasksFromNotionDatabase();

  // Return any tasks that have had their status updated.
  const updatedTasks = findUpdatedTasks(currentTasks);
  console.log(`Found ${updatedTasks.length} updated tasks.`);

  // For each updated task, update taskPageIdToStatusMap and perform further processing.
  for (const task of updatedTasks) {
    taskPageIdToStatusMap[task.pageId] = task.status;
    // Add your custom processing logic here.
    console.log(`Task "${task.title}" has been updated to "${task.status}".`);
  }
}

/**
 * Gets tasks from the database.
 */
async function getTasksFromNotionDatabase() {
  const pages = [];
  let cursor = undefined;

  while (true) {
    const { results, next_cursor } = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
    });
    pages.push(...results);
    if (!next_cursor) {
      break;
    }
    cursor = next_cursor;
  }

  console.log(pages)

  // pages.forEach(function (page) {
  //   console.log(page.properties);
  // });
  console.log(`${pages.length} pages successfully fetched.`);

  const tasks = [];
  for (const page of pages) {
    const pageId = page.id;

    const statusPropertyId = page.properties["Date"].id;
    const statusPropertyItem = await getPropertyValue({
      pageId,
      propertyId: statusPropertyId,
    });

    const status = getStatusPropertyValue(statusPropertyItem);

    const titlePropertyId = page.properties["Name"].id;
    const titlePropertyItems = await getPropertyValue({
      pageId,
      propertyId: titlePropertyId,
    });
    const title = getTitlePropertyValue(titlePropertyItems);

    tasks.push({ pageId, status, title });
  }

  return tasks;
}

/**
 * Extract status as string from property value
 */
function getStatusPropertyValue(property) {
  if (Array.isArray(property)) {
    return property?.[0]?.select?.name || "No Status";
  } else {
    return property?.select?.name || "No Status";
  }
}

/**
 * Extract title as string from property value
 */
function getTitlePropertyValue(property) {
  if (Array.isArray(property)) {
    return property?.[0]?.title?.plain_text || "No Title";
  } else {
    return property?.title?.plain_text || "No Title";
  }
}

/**
 * Compares task to most recent version of task stored in taskPageIdToStatusMap.
 * Returns any tasks that have a different status than their last version.
 */
function findUpdatedTasks(currentTasks) {
  return currentTasks.filter(currentTask => {
    const previousStatus = getPreviousTaskStatus(currentTask);
    return currentTask.status !== previousStatus;
  });
}

/**
 * Finds or creates task in local data store and returns its status.
 */
function getPreviousTaskStatus({ pageId, status }) {
  // If this task hasn't been seen before, add to local pageId to status map.
  if (!taskPageIdToStatusMap[pageId]) {
    taskPageIdToStatusMap[pageId] = status;
  }
  return taskPageIdToStatusMap[pageId];
}

/**
 * If property is paginated, returns an array of property items.
 * Otherwise, it will return a single property item.
 */
async function getPropertyValue({ pageId, propertyId }) {
  let propertyItem = await notion.pages.properties.retrieve({
    page_id: pageId,
    property_id: propertyId,
  });
  if (propertyItem.object === "property_item") {
    return propertyItem;
  }

  // Property is paginated.
  let nextCursor = propertyItem.next_cursor;
  const results = propertyItem.results || [];

  while (nextCursor !== null) {
    propertyItem = await notion.pages.properties.retrieve({
      page_id: pageId,
      property_id: propertyId,
      start_cursor: nextCursor,
    });

    if (propertyItem.object === "list") {
      nextCursor = propertyItem.next_cursor;
      results.push(...propertyItem.results);
    } else {
      nextCursor = null;
    }
  }

  return results;
}

// http://expressjs.com/en/starter/static-files.html
app.use(express.static("public"))
app.use(express.json()) // for parsing application/json

// http://expressjs.com/en/starter/basic-routing.html
app.get("/", function (request, response) {
  response.sendFile(__dirname + "/views/index.html")
})

// Create new database. The page ID is set in the environment variables.
app.post("/databases", async function (request, response) {
  const pageId = process.env.NOTION_PAGE_ID
  const title = request.body.dbName

  try {
    const newDb = await notion.databases.create({
      parent: {
        type: "page_id",
        page_id: pageId,
      },
      title: [
        {
          type: "text",
          text: {
            content: title,
          },
        },
      ],
      properties: {
        Name: {
          title: {},
        },
      },
    })
    response.json({ message: "success!", data: newDb })
  } catch (error) {
    response.json({ message: "error", error })
  }
})

// Create new page. The database ID is provided in the web form.
app.post("/pages", async function (request, response) {
  const { dbID, pageName, header } = request.body

  try {
    const newPage = await notion.pages.create({
      parent: {
        type: "database_id",
        database_id: dbID,
      },
      properties: {
        Name: {
          title: [
            {
              text: {
                content: pageName,
              },
            },
          ],
        },
      },
      children: [
        {
          object: "block",
          heading_2: {
            rich_text: [
              {
                text: {
                  content: header,
                },
              },
            ],
          },
        },
      ],
    })
    response.json({ message: "success!", data: newPage })
  } catch (error) {
    response.json({ message: "error", error })
  }
})

// Create new block (page content). The page ID is provided in the web form.
app.post("/blocks", async function (request, response) {
  const { pageID, content } = request.body

  try {
    const newBlock = await notion.blocks.children.append({
      block_id: pageID, // a block ID can be a page ID
      children: [
        {
          // Use a paragraph as a default but the form or request can be updated to allow for other block types: https://developers.notion.com/reference/block#keys
          paragraph: {
            rich_text: [
              {
                text: {
                  content: content,
                },
              },
            ],
          },
        },
      ],
    })
    response.json({ message: "success!", data: newBlock })
  } catch (error) {
    response.json({ message: "error", error })
  }
})

// Create new page comments. The page ID is provided in the web form.
app.post("/comments", async function (request, response) {
  const { pageID, comment } = request.body

  try {
    const newComment = await notion.comments.create({
      parent: {
        page_id: pageID,
      },
      rich_text: [
        {
          text: {
            content: comment,
          },
        },
      ],
    })
    response.json({ message: "success!", data: newComment })
  } catch (error) {
    response.json({ message: "error", error })
  }
})

// listen for requests :)
const listener = app.listen(process.env.PORT, function () {
  console.log("Your app is listening on port " + listener.address().port)
})
