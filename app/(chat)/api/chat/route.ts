import { auth } from '@/app/(auth)/auth';
import {
  deleteChatById,
  getChatById,
} from '@/lib/db/queries';
import { ChatSDKError } from '@/lib/errors';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { createUIMessageStream, JsonToSseTransformStream } from 'ai';
import { generateUUID } from '@/lib/utils';

export const maxDuration = 60;

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  try {
    const { message }: PostRequestBody = requestBody;
    const session = await auth();

    if (!session?.user) {
      return new ChatSDKError('unauthorized:chat').toResponse();
    }

    // --- START: Updated xAI Retrieval Logic ---

    // Correctly filter for text parts before joining
    const userMessage = message.parts
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('');
      
    const xaiApiKey = process.env.XAI_API_KEY; 
    const collectionId = 'collection_d567b17f-53c5-4011-8d69-af32b8249eec';

    // --- IMPORTANT ---
    // You must verify the correct API endpoint URL from your official xAI developer documentation.
    // The one below is a placeholder and may need to be changed.

    const response = await fetch('https://api.x.ai/v1/chat/completions', { // Note: This URL is a placeholder!
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${xaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-4-0709', 
        messages: [{ role: 'user', content: userMessage }],
        collection_id: collectionId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('xAI API Error:', errorText);
      return new ChatSDKError('bad_request:api').toResponse();
    }

    const data = await response.json();
    const finalAnswer = data.choices[0].message.content;

    // --- START: REVISED RESPONSE LOGIC ---
    // This block now simulates a word-by-word stream to match the UI's expectations.
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const words = finalAnswer.split(' ');
        for (const word of words) {
          writer.write({
            type: 'text-delta',
            id: generateUUID(),
            delta: word + ' ',
          });
          // Small delay to make it feel like a real stream for the UI
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      },
      generateId: generateUUID,
    });

    // Use the boilerplate's original method to send the stream.
    return new Response(stream.pipeThrough(new JsonToSseTransformStream()));
    // --- END: REVISED RESPONSE LOGIC ---

  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    
    console.error('An unexpected error occurred:', error);
    return new ChatSDKError('bad_request:api').toResponse();
  }
}


export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  const chat = await getChatById({ id });

  if (!chat || chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}

