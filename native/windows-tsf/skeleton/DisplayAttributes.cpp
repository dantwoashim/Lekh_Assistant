#include "DisplayAttributes.h"

#include "Guids.h"

#include <new>
#include <oleauto.h>
#include <windows.h>

extern long g_objectCount;

namespace lekh::tsf {
namespace {

constexpr TF_DISPLAYATTRIBUTE kDefaultCompositionAttribute = {
  {TF_CT_NONE, 0},
  {TF_CT_NONE, 0},
  TF_LS_DOT,
  FALSE,
  {TF_CT_NONE, 0},
  TF_ATTR_INPUT
};

constexpr TF_DISPLAYATTRIBUTE kDefaultGhostAttribute = {
  {TF_CT_SYSCOLOR, COLOR_GRAYTEXT},
  {TF_CT_NONE, 0},
  TF_LS_NONE,
  FALSE,
  {TF_CT_NONE, 0},
  TF_ATTR_INPUT
};

class CompositionDisplayAttributeInfo final : public ITfDisplayAttributeInfo {
public:
  explicit CompositionDisplayAttributeInfo(bool ghost = false)
    : ghost_(ghost), attribute_(ghost ? kDefaultGhostAttribute : kDefaultCompositionAttribute) {
    InterlockedIncrement(&g_objectCount);
  }

  STDMETHODIMP QueryInterface(REFIID riid, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (riid != IID_IUnknown && riid != IID_ITfDisplayAttributeInfo) return E_NOINTERFACE;
    *object = static_cast<ITfDisplayAttributeInfo*>(this);
    AddRef();
    return S_OK;
  }

  STDMETHODIMP_(ULONG) AddRef() override {
    return static_cast<ULONG>(InterlockedIncrement(&refCount_));
  }

  STDMETHODIMP_(ULONG) Release() override {
    const ULONG count = static_cast<ULONG>(InterlockedDecrement(&refCount_));
    if (count == 0) delete this;
    return count;
  }

  STDMETHODIMP GetGUID(GUID* guid) override {
    if (!guid) return E_POINTER;
    *guid = ghost_ ? GUID_LekhGhostDisplayAttribute : GUID_LekhCompositionDisplayAttribute;
    return S_OK;
  }

  STDMETHODIMP GetDescription(BSTR* description) override {
    if (!description) return E_POINTER;
    *description = SysAllocString(ghost_ ? L"Lekh ghost suggestion" : L"Lekh composing text");
    return *description ? S_OK : E_OUTOFMEMORY;
  }

  STDMETHODIMP GetAttributeInfo(TF_DISPLAYATTRIBUTE* attribute) override {
    if (!attribute) return E_POINTER;
    *attribute = attribute_;
    return S_OK;
  }

  STDMETHODIMP SetAttributeInfo(const TF_DISPLAYATTRIBUTE* attribute) override {
    if (!attribute) return E_POINTER;
    attribute_ = *attribute;
    return S_OK;
  }

  STDMETHODIMP Reset() override {
    attribute_ = ghost_ ? kDefaultGhostAttribute : kDefaultCompositionAttribute;
    return S_OK;
  }

private:
  ~CompositionDisplayAttributeInfo() {
    InterlockedDecrement(&g_objectCount);
  }

  long refCount_ = 1;
  bool ghost_ = false;
  TF_DISPLAYATTRIBUTE attribute_ = kDefaultCompositionAttribute;
};

class CompositionDisplayAttributeEnumerator final : public IEnumTfDisplayAttributeInfo {
public:
  CompositionDisplayAttributeEnumerator() {
    InterlockedIncrement(&g_objectCount);
  }

  STDMETHODIMP QueryInterface(REFIID riid, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (riid != IID_IUnknown && riid != IID_IEnumTfDisplayAttributeInfo) return E_NOINTERFACE;
    *object = static_cast<IEnumTfDisplayAttributeInfo*>(this);
    AddRef();
    return S_OK;
  }

  STDMETHODIMP_(ULONG) AddRef() override {
    return static_cast<ULONG>(InterlockedIncrement(&refCount_));
  }

  STDMETHODIMP_(ULONG) Release() override {
    const ULONG count = static_cast<ULONG>(InterlockedDecrement(&refCount_));
    if (count == 0) delete this;
    return count;
  }

  STDMETHODIMP Clone(IEnumTfDisplayAttributeInfo** enumerator) override {
    if (!enumerator) return E_POINTER;
    *enumerator = nullptr;
    auto* clone = new (std::nothrow) CompositionDisplayAttributeEnumerator();
    if (!clone) return E_OUTOFMEMORY;
    clone->index_ = index_;
    *enumerator = clone;
    return S_OK;
  }

  STDMETHODIMP Next(
    ULONG count,
    ITfDisplayAttributeInfo** information,
    ULONG* fetched
  ) override {
    if (fetched) *fetched = 0;
    if (count == 0) return S_OK;
    if (!information || (count != 1 && !fetched)) return E_POINTER;
    for (ULONG index = 0; index < count; ++index) information[index] = nullptr;
    ULONG produced = 0;
    while (produced < count && index_ < 2) {
      auto* item = new (std::nothrow) CompositionDisplayAttributeInfo(index_ == 1);
      if (!item) {
        if (fetched) *fetched = produced;
        return produced == 0 ? E_OUTOFMEMORY : S_FALSE;
      }
      information[produced++] = item;
      ++index_;
    }
    if (fetched) *fetched = produced;
    return produced == count ? S_OK : S_FALSE;
  }

  STDMETHODIMP Reset() override {
    index_ = 0;
    return S_OK;
  }

  STDMETHODIMP Skip(ULONG count) override {
    if (count == 0) return S_OK;
    const ULONG remaining = 2 - index_;
    const ULONG skipped = count < remaining ? count : remaining;
    index_ += skipped;
    return skipped == count ? S_OK : S_FALSE;
  }

private:
  ~CompositionDisplayAttributeEnumerator() {
    InterlockedDecrement(&g_objectCount);
  }

  long refCount_ = 1;
  ULONG index_ = 0;
};

} // namespace

HRESULT registerCompositionDisplayAttribute(TfGuidAtom* atom) {
  if (!atom) return E_POINTER;
  *atom = TF_INVALID_GUIDATOM;
  ITfCategoryMgr* categoryManager = nullptr;
  HRESULT hr = CoCreateInstance(
    CLSID_TF_CategoryMgr,
    nullptr,
    CLSCTX_INPROC_SERVER,
    IID_ITfCategoryMgr,
    reinterpret_cast<void**>(&categoryManager)
  );
  if (FAILED(hr) || !categoryManager) return FAILED(hr) ? hr : E_NOINTERFACE;
  hr = categoryManager->RegisterGUID(GUID_LekhCompositionDisplayAttribute, atom);
  categoryManager->Release();
  return hr;
}

HRESULT registerGhostDisplayAttribute(TfGuidAtom* atom) {
  if (!atom) return E_POINTER;
  *atom = TF_INVALID_GUIDATOM;
  ITfCategoryMgr* categoryManager = nullptr;
  HRESULT hr = CoCreateInstance(
    CLSID_TF_CategoryMgr,
    nullptr,
    CLSCTX_INPROC_SERVER,
    IID_ITfCategoryMgr,
    reinterpret_cast<void**>(&categoryManager)
  );
  if (FAILED(hr) || !categoryManager) return FAILED(hr) ? hr : E_NOINTERFACE;
  hr = categoryManager->RegisterGUID(GUID_LekhGhostDisplayAttribute, atom);
  categoryManager->Release();
  return hr;
}

HRESULT createDisplayAttributeEnumerator(IEnumTfDisplayAttributeInfo** enumerator) {
  if (!enumerator) return E_POINTER;
  *enumerator = new (std::nothrow) CompositionDisplayAttributeEnumerator();
  return *enumerator ? S_OK : E_OUTOFMEMORY;
}

HRESULT createDisplayAttributeInfo(REFGUID guid, ITfDisplayAttributeInfo** information) {
  if (!information) return E_POINTER;
  *information = nullptr;
  const bool ghost = IsEqualGUID(guid, GUID_LekhGhostDisplayAttribute);
  if (!ghost && !IsEqualGUID(guid, GUID_LekhCompositionDisplayAttribute)) return E_INVALIDARG;
  *information = new (std::nothrow) CompositionDisplayAttributeInfo(ghost);
  return *information ? S_OK : E_OUTOFMEMORY;
}

} // namespace lekh::tsf
