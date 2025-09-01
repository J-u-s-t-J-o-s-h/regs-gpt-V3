import {
  convertToModelMessages,
  createUIMessageStream,
  JsonToSseTransformStream,
  smoothStream,
  stepCountIs,
  streamText,
} from 'ai';
import { auth, type UserType } from '@/app/(auth)/auth';
import { type RequestHints, systemPrompt } from '@/lib/ai/prompts';
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { convertToUIMessages, generateUUID } from '@/lib/utils';
import { generateTitleFromUserMessage } from '../../actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { isProductionEnvironment } from '@/lib/constants';
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import { ChatSDKError } from '@/lib/errors';
import type { ChatMessage } from '@/lib/types';
import type { ChatModel } from '@/lib/ai/models';
import type { VisibilityType } from '@/components/visibility-selector';

export const maxDuration = 60;

// This helper function is part of the original boilerplate and is kept for potential future use.
let globalStreamContext: ResumableStreamContext | null = null;

// The 'export' keyword has been removed from this function to fix the build error.
function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({
        waitUntil: after,
      });
    } catch (error: any) {
      if (error.message.includes('REDIS_URL')) {
        console.log(
          ' > Resumable streams are disabled due to missing REDIS_URL',
        );
      } else {
        console.error(error);
      }
    }
  }
  return globalStreamContext;
}

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

    // --- START: New xAI Retrieval Logic ---

    // Correctly filter for text parts before joining
    const userMessage = message.parts
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('');
      
    const groqApiKey = process.env.GROQ_API_KEY; // Using your Groq key
    const collectionId = 'collection_d567b17f-53c5-4011-8d69-af32b8249eec';

    // --- IMPORTANT ---
    // The code below is a conceptual example based on how modern AI APIs work.
    // You MUST verify the correct API endpoint URL and request body structure
    // from your official xAI developer documentation.

    const response = await fetch('https://api.x.ai/v1/chat/completions', { // Note: This URL is a placeholder!
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqApiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-1', // Or the specific model you intend to use
        messages: [{ role: 'user', content: userMessage }],
        // This is the critical part that tells the API to use your documents:
        collection_id: collectionId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('xAI API Error:', errorText);
      // Using a valid error type
      return new ChatSDKError('bad_request:api').toResponse();
    }

    // Assuming the API returns a standard JSON response
    const data = await response.json();
    const finalAnswer = data.choices[0].message.content;

    // We send the final answer back directly as a plain text response.
    return new Response(finalAnswer);

    // --- END: New xAI Retrieval Logic ---

  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    
    console.error('An unexpected error occurred:', error);
    // Using a valid error type
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

  if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}

