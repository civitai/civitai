import { CloseButton } from '@mantine/core';
import React, { useState } from 'react';
import createSlots from '~/libs/slots/create-slots';

// ---------------------------------------------------------------------------
// Setup: create a slot system with 'header' and 'footer' named slots
// ---------------------------------------------------------------------------
const {
  SlotProvider,
  Slot,
  RenderSlot,
  // Convenience components (auto-capitalized from slot names)
  Header,
  Footer,
  RenderHeader,
  RenderFooter,
} = createSlots(['header', 'footer']);

// ---------------------------------------------------------------------------
// Example 1: Basic — slot declared as direct child
// ---------------------------------------------------------------------------
function BasicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-dark-4">
      <div className="border-b border-dark-4 bg-dark-6 p-3 font-semibold text-white">
        <RenderHeader fallback={<span className="text-gray-5">No header provided</span>} />
      </div>
      <div className="bg-dark-7 p-4 text-gray-3">{children}</div>
      <div className="border-t border-dark-4 bg-dark-6 p-3 text-sm text-gray-5">
        <RenderFooter fallback={<span>Default footer</span>} />
      </div>
    </div>
  );
}

function BasicExample() {
  return (
    <SlotProvider>
      <BasicLayout>
        <Header>Panel Title</Header>
        <p>Body content goes here. Header and Footer are direct children but get portaled.</p>
      </BasicLayout>
      <Footer>Custom footer text</Footer>
    </SlotProvider>
  );
}

// ---------------------------------------------------------------------------
// Example 2: Deep slots — declared from a nested component
// ---------------------------------------------------------------------------
function PageContent() {
  return (
    <div>
      <p>This component is deeply nested, but it can still claim a slot.</p>
      <DeepChild />
    </div>
  );
}

function DeepChild() {
  return (
    <>
      <p>Content from DeepChild.</p>
      <Footer>
        <span>Footer set from DeepChild — works from any depth in the tree</span>
      </Footer>
    </>
  );
}

function DeepSlotExample() {
  return (
    <SlotProvider>
      <BasicLayout>
        <Header>Deep Slots Demo</Header>
        <PageContent />
      </BasicLayout>
    </SlotProvider>
  );
}

// ---------------------------------------------------------------------------
// Example 3: Dynamic — toggle which component provides the footer
// ---------------------------------------------------------------------------
function FooterA() {
  return <Footer>Footer variant A — the default</Footer>;
}

function FooterB() {
  return <Footer>Footer variant B — an alternative</Footer>;
}

function DynamicSlotExample() {
  const [variant, setVariant] = useState<'a' | 'b' | 'none'>('a');

  return (
    <SlotProvider>
      <BasicLayout>
        <Header>Dynamic Slot Switching</Header>
        <div className="flex flex-col gap-3">
          <p>Select which component provides the footer:</p>
          <div className="flex gap-3">
            {(['a', 'b', 'none'] as const).map((v) => (
              <label key={v} className="flex items-center gap-1.5 text-sm text-gray-3">
                <input
                  type="radio"
                  name="variant"
                  checked={variant === v}
                  onChange={() => setVariant(v)}
                />
                {v === 'none' ? 'No footer' : `Variant ${v.toUpperCase()}`}
              </label>
            ))}
          </div>
          {variant === 'a' && <FooterA />}
          {variant === 'b' && <FooterB />}
        </div>
      </BasicLayout>
    </SlotProvider>
  );
}

// ---------------------------------------------------------------------------
// Example 4: Using the generic Slot/RenderSlot directly
// ---------------------------------------------------------------------------
function GenericExample() {
  return (
    <SlotProvider>
      <div className="flex flex-col overflow-hidden rounded-lg border border-dark-4">
        <div className="bg-dark-6 p-3 text-white">
          <RenderSlot name="header" fallback={<span className="text-gray-5">---</span>} />
        </div>
        <div className="bg-dark-7 p-4 text-gray-3">
          <p>Using Slot/RenderSlot directly with the name prop.</p>
          <Slot name="header">
            <span className="font-semibold">Generic slot header</span>
          </Slot>
        </div>
        <div className="bg-dark-6 p-3 text-sm text-gray-5">
          <RenderSlot name="footer" fallback={<span>No footer</span>} />
        </div>
      </div>
    </SlotProvider>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
function Test2() {
  return (
    <div className="container flex max-w-lg flex-col gap-8 py-8">
      <div>
        <h2 className="mb-3 text-lg font-bold text-white">1. Basic portal slots</h2>
        <p className="mb-2 text-sm text-gray-5">
          Header and Footer are portaled into the layout from outside BasicLayout.
        </p>
        <BasicExample />
      </div>

      <div>
        <h2 className="mb-3 text-lg font-bold text-white">2. Deep nested slots</h2>
        <p className="mb-2 text-sm text-gray-5">
          Footer is declared from DeepChild, several levels down.
        </p>
        <DeepSlotExample />
      </div>

      <div>
        <h2 className="mb-3 text-lg font-bold text-white">3. Dynamic slot switching</h2>
        <p className="mb-2 text-sm text-gray-5">
          Different components can claim the same slot — toggle between them.
        </p>
        <DynamicSlotExample />
      </div>

      <div>
        <h2 className="mb-3 text-lg font-bold text-white">4. Generic Slot / RenderSlot API</h2>
        <p className="mb-2 text-sm text-gray-5">
          Using the lower-level Slot and RenderSlot with name props directly.
        </p>
        <GenericExample />
      </div>
    </div>
  );
}

export default Test2;
