#pragma once

#include <msctf.h>

namespace lekh::tsf {

HRESULT registerCompositionDisplayAttribute(TfGuidAtom* atom);
HRESULT registerGhostDisplayAttribute(TfGuidAtom* atom);

HRESULT createDisplayAttributeEnumerator(IEnumTfDisplayAttributeInfo** enumerator);

HRESULT createDisplayAttributeInfo(
  REFGUID guid,
  ITfDisplayAttributeInfo** information
);

} // namespace lekh::tsf
